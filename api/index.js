const fetch = require('node-fetch');
const https = require('https');

const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Range, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Content-Range, Range, Accept-Ranges');

    if (req.method === 'OPTIONS') {
        console.log('[Proxy Vercel] Requête OPTIONS (Preflight CORS) reçue.');
        return res.status(204).end();
    }

    const { url } = req.query;

    if (!url) {
        console.error('[Proxy Vercel] Erreur: Paramètre "url" manquant dans la requête.');
        return res.status(400).send('Missing "url" query parameter.');
    }

    let decodedUrl;

    try {
        decodedUrl = decodeURIComponent(url);
        console.log(`\n--- [Proxy Vercel] Nouvelle Requête ---`);
        console.log(`[Proxy Vercel] Requête reçue pour le flux: ${decodedUrl}`);
        console.log(`[Proxy Vercel] Méthode HTTP de la requête client: ${req.method}`);
        console.log(`[Proxy Vercel] En-têtes de la requête client:\n${JSON.stringify(req.headers, null, 2)}`);

        const useHttpsAgent = decodedUrl.startsWith('https://');

        const requestHeaders = {};
        requestHeaders['User-Agent'] = 'VLC/3.0.18 LibVLC/3.0.18';

        if (req.headers['accept']) requestHeaders['Accept'] = req.headers['accept'];
        if (req.headers['authorization']) requestHeaders['Authorization'] = req.headers['authorization'];
        if (req.headers['accept-language']) requestHeaders['Accept-language'] = req.headers['accept-language'];
        requestHeaders['Accept-Encoding'] = 'identity';

        // Rendre la détection .m3u8 plus robuste (ignorer les paramètres d'URL)
        const urlPath = new URL(decodedUrl).pathname;
        const endsWithM3u8 = urlPath.toLowerCase().endsWith('.m3u8');

        if (req.headers['range'] && !endsWithM3u8) {
            requestHeaders['Range'] = req.headers['range'];
            console.log('[Proxy Vercel] En-tête Range transmis car ce n\'est pas un manifeste HLS.');
        } else if (req.headers['range'] && endsWithM3u8) {
            console.warn('[Proxy Vercel] En-tête Range ignoré pour un manifeste HLS. Le client ne devrait pas le demander pour le manifeste principal.');
        }

        console.log(`[Proxy Vercel] En-têtes envoyés au serveur original:\n${JSON.stringify(requestHeaders, null, 2)}`);

        const response = await fetch(decodedUrl, {
            method: req.method,
            headers: requestHeaders,
            agent: useHttpsAgent ? httpsAgent : undefined
        });

        console.log(`[Proxy Vercel] Réponse du serveur original - Statut: ${response.status} ${response.statusText}`);
        console.log(`[Proxy Vercel] Réponse du serveur original - En-têtes:\n${JSON.stringify(Object.fromEntries(response.headers), null, 2)}`);

        if (!response.ok && response.status !== 206) {
            const errorBody = await response.text();
            console.error(`[Proxy Vercel] Erreur lors de la récupération du flux original: ${response.status} ${response.statusText} pour URL: ${decodedUrl}. Corps de l'erreur: ${errorBody.substring(0, 500)}`);
            return res.status(response.status).send(`Failed to fetch original stream: ${response.statusText}. Details: ${errorBody.substring(0, 200)}...`);
        }

        const contentType = response.headers.get('content-type');
        console.log(`[Proxy Vercel] Content-Type du flux original: ${contentType}`);

        // --- NOUVELLE LOGIQUE DE DÉTECTION DU MANIFESTE HLS ---
        let isHlsManifestContent = false;
        if (contentType) {
            const normalizedContentType = contentType.toLowerCase().trim(); // Normalisation
            isHlsManifestContent = (
                normalizedContentType.includes('application/x-mpegurl') ||
                normalizedContentType.includes('application/vnd.apple.mpegurl') ||
                (normalizedContentType.includes('text/plain') && endsWithM3u8) || // Utilise endsWithM3u8 ici
                (normalizedContentType.includes('application/octet-stream') && endsWithM3u8) // Utilise endsWithM3u8 ici
            );
        }
        // --- FIN NOUVELLE LOGIQUE DE DÉTECTION DU MANIFESTE HLS ---


        // --- NOUVEAUX LOGS DE DÉBOGAGE POUR LA CONDITION PRINCIPALE ---
        console.log(`[Proxy Vercel] Débogage condition (après correction) :`);
        console.log(`[Proxy Vercel] - normalizedContentType: ${contentType ? contentType.toLowerCase().trim() : 'null'}`);
        console.log(`[Proxy Vercel] - endsWithM3u8: ${endsWithM3u8}`);
        console.log(`[Proxy Vercel] - isHlsManifestContent: ${isHlsManifestContent}`);
        console.log(`[Proxy Vercel] - response.status: ${response.status}`);
        console.log(`[Proxy Vercel] - Condition complète (isHlsManifestContent && response.status === 200): ${isHlsManifestContent && response.status === 200}`);
        // --- FIN NOUVEAUX LOGS DE DÉBOGAGE ---

        if (isHlsManifestContent && response.status === 200) {
            console.log('[Proxy Vercel] Manifeste HLS (200 OK) détecté. Lecture du corps pour réécriture...');
            const m3u8Content = await response.text();
            let modifiedM3u8Content = m3u8Content;

            const originalUrlObj = new URL(decodedUrl);
            const originalBaseUrl = originalUrlObj.protocol + '//' + originalUrlObj.host + originalUrlObj.pathname.substring(0, originalUrlObj.pathname.lastIndexOf('/') + 1);
            console.log(`[Proxy Vercel] Base URL pour résolution relative: ${originalBaseUrl}`);

            modifiedM3u8Content = modifiedM3u8Content.replace(
                /(?:^|\n)([^#\n]+?\.(?:m3u8|ts|mp4|aac|mp3|key)(?:[?#][^\n]*)?\s*$)|(URI=")([^"]+?)(")|(#EXTINF:[^,\n]+,\s*)([^\n]+)/g,
                (match, p1_standalone_url, p3_uri_prefix, p4_uri_path, p5_uri_suffix, p6_extinf_prefix, p7_extinf_path) => {
                    let originalPath = '';
                    if (p1_standalone_url) {
                        originalPath = p1_standalone_url.trim();
                    } else if (p4_uri_path) {
                        originalPath = p4_uri_path.trim();
                    } else if (p7_extinf_path) {
                        originalPath = p7_extinf_path.trim();
                    }

                    if (!originalPath || originalPath.startsWith('#') || originalPath.startsWith('/api?url=') || originalPath.match(/^(https?:\/\/|data:)/)) {
                        console.log(`[Proxy Vercel]  - URL non modifiée (déjà absolue/proxy/commentaire): '${originalPath || match.substring(0, 50)}...'`);
                        return match;
                    }

                    let absoluteOriginalUrl;
                    try {
                        absoluteOriginalUrl = new URL(originalPath, originalBaseUrl).href;
                        console.log(`[Proxy Vercel]  - Résolution URL: '${originalPath}' (base: ${originalBaseUrl}) -> '${absoluteOriginalUrl}'`);
                    } catch (e) {
                        console.error(`[Proxy Vercel]  - Erreur de construction d'URL absolue: ${e.message} pour chemin: '${originalPath}' (base: ${originalBaseUrl})`);
                        absoluteOriginalUrl = originalPath;
                    }
                    
                    if (absoluteOriginalUrl.includes('/api?url=') && absoluteOriginalUrl.includes(req.headers.host)) {
                         console.log(`[Proxy Vercel]  - URL déjà proxyfiée détectée après résolution: ${absoluteOriginalUrl}. Non modifiée.`);
                         return match;
                    }

                    const proxifiedUrl = `/api?url=${encodeURIComponent(absoluteOriginalUrl)}`;
                    console.log(`[Proxy Vercel]  - URL proxyfiée: ${proxifiedUrl}`);

                    if (p1_standalone_url) {
                        return `${proxifiedUrl}`;
                    } else if (p4_uri_path) {
                        return `${p3_uri_prefix}${proxifiedUrl}${p5_uri_suffix}`;
                    } else if (p7_extinf_path) {
                        return `${p6_extinf_prefix}${proxifiedUrl}`;
                    }
                    return match;
                }
            );

            res.setHeader('Content-Type', 'application/x-mpegurl');
            res.status(200).send(modifiedM3u8Content);
            console.log('[Proxy Vercel] Manifeste HLS réécrit et envoyé au client.');
            console.log('[Proxy Vercel] Manifeste réécrit (extrait):\n' + modifiedM3u8Content.substring(0, 500) + '...');

        } else {
            if (contentType) {
                res.setHeader('Content-Type', contentType);
            } else if (decodedUrl.endsWith('.ts')) {
                res.setHeader('Content-Type', 'video/mp2t');
            } else if (decodedUrl.endsWith('.aac')) {
                res.setHeader('Content-Type', 'audio/aac');
            } else if (decodedUrl.endsWith('.mp3')) {
                res.setHeader('Content-Type', 'audio/mpeg');
            } else if (decodedUrl.endsWith('.mp4')) {
                res.setHeader('Content-Type', 'video/mp4');
            } else if (decodedUrl.endsWith('.key')) {
                 res.setHeader('Content-Type', 'application/octet-stream');
            }
            res.status(response.status);
            response.body.pipe(res);
            console.log('[Proxy Vercel] Contenu non-manifeste ou non-200 OK transféré directement au client.');
        }

    } catch (error) {
        console.error(`[Proxy Vercel] Erreur inattendue dans le traitement: ${error.message}`);
        console.error(`[Proxy Vercel] Stack trace de l'erreur:\n${error.stack}`);
        res.status(500).send(`Proxy error: ${error.message}`);
    }
};