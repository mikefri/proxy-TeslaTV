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
        // ANCIEN : requestHeaders['User-Agent'] = 'VLC/3.0.18 LibVLC/3.0.18';
        // NOUVEAU : Utiliser un User-Agent de navigateur ou transmettre celui du client
        if (req.headers['user-agent']) {
            requestHeaders['User-Agent'] = req.headers['user-agent']; // Transmettre le User-Agent du navigateur client
            console.log('[Proxy Vercel] User-Agent du client transmis.');
        } else {
            // Fallback si aucun User-Agent n'est fourni par le client (moins courant)
            requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36';
            console.log('[Proxy Vercel] User-Agent de navigateur générique utilisé.');
        }


        if (req.headers['accept']) requestHeaders['Accept'] = req.headers['accept'];
        if (req.headers['authorization']) requestHeaders['Authorization'] = req.headers['authorization'];
        if (req.headers['accept-language']) requestHeaders['Accept-language'] = req.headers['accept-language'];
        requestHeaders['Accept-Encoding'] = 'identity'; // Important pour ne pas compresser le flux vidéo

        // Ajout des en-têtes Referer et Origin si présents, souvent vérifiés par les serveurs
        if (req.headers['referer']) requestHeaders['Referer'] = req.headers['referer'];
        if (req.headers['origin']) requestHeaders['Origin'] = req.headers['origin'];


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

        let isHlsManifestContent = false;
        if (contentType) {
            const normalizedContentType = contentType.toLowerCase().trim();
            isHlsManifestContent = (
                normalizedContentType.includes('application/x-mpegurl') ||
                normalizedContentType.includes('application/vnd.apple.mpegurl') ||
                (normalizedContentType.includes('text/plain') && endsWithM3u8) ||
                (normalizedContentType.includes('application/octet-stream') && endsWithM3u8)
            );
        }

        console.log(`[Proxy Vercel] Débogage condition (après correction) :`);
        console.log(`[Proxy Vercel] - normalizedContentType: ${contentType ? contentType.toLowerCase().trim() : 'null'}`);
        console.log(`[Proxy Vercel] - endsWithM3u8: ${endsWithM3u8}`);
        console.log(`[Proxy Vercel] - isHlsManifestContent: ${isHlsManifestContent}`);
        console.log(`[Proxy Vercel] - response.status: ${response.status}`);
        console.log(`[Proxy Vercel] - Condition complète (isHlsManifestContent && response.status === 200): ${isHlsManifestContent && response.status === 200}`);

        if (isHlsManifestContent && response.status === 200) {
            console.log('[Proxy Vercel] Manifeste HLS (200 OK) détecté. Lecture du corps pour réécriture...');
            const m3u8Content = await response.text();
            let modifiedM3u8Content = m3u8Content;

            const originalUrlObj = new URL(decodedUrl);
            const originalBaseUrl = originalUrlObj.protocol + '//' + originalUrlObj.host + originalUrlObj.pathname.substring(0, originalUrlObj.pathname.lastIndexOf('/') + 1);
            console.log(`[Proxy Vercel] Base URL pour résolution relative: ${originalBaseUrl}`);

            // Regex mis à jour pour mieux capturer les URLs standalone en fin de ligne
            // Capture:
            // 1. Une URL autonome sur sa propre ligne (groupes 1 et 2)
            // 2. Une URL dans un attribut URI="..." (groupes 3, 4, 5)
            // 3. Une URL après #EXTINF: (groupes 6, 7)
            modifiedM3u8Content = modifiedM3u8Content.replace(
                /(^|\n)([^#\n]+?\.(?:m3u8|ts|mp4|aac|mp3|key)(?:[?#][^\n]*)?\s*$)|(URI=")([^"]+?)(")|(#EXTINF:[^,\n]+,\s*)([^\n]+)/g,
                (match, p1_line_prefix, p2_standalone_url, p3_uri_prefix, p4_uri_path, p5_uri_suffix, p6_extinf_prefix, p7_extinf_path) => {
                    let originalPath = '';
                    let prefix = '';

                    if (p2_standalone_url) { // Cas 1: URL autonome sur sa propre ligne
                        originalPath = p2_standalone_url.trim();
                        prefix = p1_line_prefix;
                    } else if (p4_uri_path) { // Cas 2: URL dans URI="..."
                        originalPath = p4_uri_path.trim();
                        prefix = p3_uri_prefix;
                    } else if (p7_extinf_path) { // Cas 3: URL après #EXTINF:
                        originalPath = p7_extinf_path.trim();
                        prefix = p6_extinf_prefix;
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

                    // Construction du remplacement basée sur le cas de capture
                    if (p2_standalone_url) { // Cas 1: URL autonome
                        return `${prefix}${proxifiedUrl}`;
                    } else if (p4_uri_path) { // Cas 2: URL dans URI="..."
                        return `${p3_uri_prefix}${proxifiedUrl}${p5_uri_suffix}`;
                    } else if (p7_extinf_path) { // Cas 3: URL après #EXTINF:
                        return `${p6_extinf_prefix}${proxifiedUrl}`;
                    }
                    return match; // Ne devrait jamais arriver
                }
            );

            res.setHeader('Content-Type', 'application/x-mpegurl');
            res.status(200).send(modifiedM3u8Content);
            console.log('[Proxy Vercel] Manifeste HLS réécrit et envoyé au client.');
            console.log('[Proxy Vercel] Manifeste réécrit (extrait):\n' + modifiedM3u8Content.substring(0, 500) + '...');

        } else {
            if (contentType) {
                res.setHeader('Content-Type', contentType);
            } else if (endsWithM3u8) { // Fallback pour les .m3u8 qui ne sont pas 200 OK ou avec un type non standard
                res.setHeader('Content-Type', 'application/x-mpegurl');
            } else if (decodedUrl.endsWith('.ts')) {
                res.setHeader('Content-Type', 'video/mp2t');
            } else if (decodedUrl.endsWith('.aac')) {
                res.setHeader('Content-Type', 'audio/aac');
            } else if (decodedUrl.endsWith('.mp3')) {
                res.setHeader('Content-Type', 'audio/mpeg');
            } else if (decodedUrl.endsWith('.mp4')) {
                res.setHeader('Content-Type', 'video/mp4');
            } else if (decodedUrl.endsWith('.mkv')) { // Ajouté précédemment, maintenu
                res.setHeader('Content-Type', 'video/x-matroska');
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
