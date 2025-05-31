const fetch = require('node-fetch');
const https = require('https');

const httpsAgent = new https.Agent({
    rejectUnauthorized: false // Permet d'ignorer les erreurs de certificat SSL (à utiliser avec prudence en production)
});

module.exports = async (req, res) => {
    // --- En-têtes CORS pour le client (votre site web) ---
    res.setHeader('Access-Control-Allow-Origin', '*'); // Autorise toutes les origines (attention en production, préférez votre domaine spécifique)
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Range, Authorization, If-None-Match, If-Modified-Since');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Content-Range, Range, Accept-Ranges, ETag, Last-Modified');
    res.setHeader('Access-Control-Max-Age', '86400'); // Cache les informations CORS pendant 24 heures

    // Gère la requête OPTIONS (preflight CORS)
    if (req.method === 'OPTIONS') {
        console.log('[Proxy Vercel] Requête OPTIONS (Preflight CORS) reçue.');
        return res.status(204).end(); // Répond avec un statut 204 No Content
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
        // Transfert sélectif des en-têtes de la requête client au serveur original
        const headersToForward = [
            'User-Agent', 'Accept', 'Authorization', 'Accept-Language',
            'Referer', 'Origin', 'Range', 'If-None-Match', 'If-Modified-Since',
            'Content-Type', 'Content-Length', // Pour les requêtes POST/PUT si applicables
            'Cookie' // ATTENTION: peut avoir des implications de sécurité/vie privée
        ];

        headersToForward.forEach(headerName => {
            const clientHeaderValue = req.headers[headerName.toLowerCase()];
            if (clientHeaderValue) {
                requestHeaders[headerName] = clientHeaderValue;
                console.log(`[Proxy Vercel] En-tête client transmis: ${headerName}: ${clientHeaderValue}`);
            }
        });

        // Assurez-vous que l'encodage d'acceptation ne compresse pas les flux binaires
        requestHeaders['Accept-Encoding'] = 'identity'; // Important pour ne pas compresser le flux vidéo

        // Si le client demande un range mais ce n'est pas un manifeste HLS, transmettez-le
        // Sinon, ignorez le range pour les manifestes pour éviter des comportements inattendus
        const urlPath = new URL(decodedUrl).pathname;
        const endsWithM3u8 = urlPath.toLowerCase().endsWith('.m3u8');

        if (req.headers['range'] && !endsWithM3u8) {
            requestHeaders['Range'] = req.headers['range'];
            console.log('[Proxy Vercel] En-tête Range transmis car ce n\'est pas un manifeste HLS.');
        } else if (req.headers['range'] && endsWithM3u8) {
            console.warn('[Proxy Vercel] En-tête Range ignoré pour un manifeste HLS. Le client ne devrait pas le demander pour le manifeste principal.');
            delete requestHeaders['Range']; // S'assurer qu'il n'est pas envoyé
        }

        console.log(`[Proxy Vercel] En-têtes envoyés au serveur original:\n${JSON.stringify(requestHeaders, null, 2)}`);

        // Effectue la requête au serveur original
        const response = await fetch(decodedUrl, {
            method: req.method,
            headers: requestHeaders,
            agent: useHttpsAgent ? httpsAgent : undefined,
            // Si la requête client est POST/PUT, transmettez le corps de la requête
            body: (req.method === 'POST' || req.method === 'PUT') ? req : undefined
        });

        console.log(`[Proxy Vercel] Réponse du serveur original - Statut: ${response.status} ${response.statusText}`);
        console.log(`[Proxy Vercel] Réponse du serveur original - En-têtes:\n${JSON.stringify(Object.fromEntries(response.headers), null, 2)}`);

        // Gère les erreurs de la réponse du serveur original
        if (!response.ok && response.status !== 206) { // 206 Partial Content est OK pour les requêtes Range
            const errorBody = await response.text();
            console.error(`[Proxy Vercel] Erreur lors de la récupération du flux original: ${response.status} ${response.statusText} pour URL: ${decodedUrl}. Corps de l'erreur: ${errorBody.substring(0, 500)}`);
            return res.status(response.status).send(`Failed to fetch original stream: ${response.statusText}. Details: ${errorBody.substring(0, 200)}...`);
        }

        // --- Transfert des en-têtes de réponse du serveur original au client ---
        // Sauf ceux qui sont gérés spécifiquement par le proxy (e.g., CORS headers)
        response.headers.forEach((value, name) => {
            // Excluez les en-têtes qui pourraient causer des conflits ou qui sont déjà gérés par le proxy
            const excludedHeaders = [
                'access-control-allow-origin', // Géré par le proxy
                'access-control-allow-methods', // Géré par le proxy
                'access-control-allow-headers', // Géré par le proxy
                'access-control-expose-headers', // Géré par le proxy
                'access-control-max-age', // Géré par le proxy
                'set-cookie' // Peut être un problème de sécurité/vie privée si des cookies sont transférés
            ];
            if (!excludedHeaders.includes(name.toLowerCase())) {
                res.setHeader(name, value);
            }
        });

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

        console.log(`[Proxy Vercel] Débogage condition :`);
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

                    if (p2_standalone_url) {
                        return `${prefix}${proxifiedUrl}`;
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
            // Pour tous les autres types de contenu (vidéo, audio, etc.)
            // Tente de définir le Content-Type basé sur la réponse originale ou l'extension
            if (contentType) {
                res.setHeader('Content-Type', contentType);
            } else if (endsWithM3u8) {
                res.setHeader('Content-Type', 'application/x-mpegurl');
            } else if (decodedUrl.endsWith('.ts')) {
                res.setHeader('Content-Type', 'video/mp2t');
            } else if (decodedUrl.endsWith('.aac')) {
                res.setHeader('Content-Type', 'audio/aac');
            } else if (decodedUrl.endsWith('.mp3')) {
                res.setHeader('Content-Type', 'audio/mpeg');
            } else if (decodedUrl.endsWith('.mp4')) {
                res.setHeader('Content-Type', 'video/mp4');
            } else if (decodedUrl.endsWith('.mkv')) {
                res.setHeader('Content-Type', 'video/x-matroska');
            } else if (decodedUrl.endsWith('.key')) {
                res.setHeader('Content-Type', 'application/octet-stream');
            }

            // Si le serveur original a répondu avec un Range (206 Partial Content), assurez-vous que le proxy le transmet
            if (response.status === 206 && response.headers.has('content-range')) {
                res.setHeader('Content-Range', response.headers.get('content-range'));
            }

            // Transfert le statut HTTP du serveur original
            res.status(response.status);
            // Pipe le corps de la réponse du serveur original directement au client
            response.body.pipe(res);
            console.log('[Proxy Vercel] Contenu non-manifeste ou non-200 OK (y compris 206) transféré directement au client.');
        }

    } catch (error) {
        console.error(`[Proxy Vercel] Erreur inattendue dans le traitement: ${error.message}`);
        console.error(`[Proxy Vercel] Stack trace de l'erreur:\n${error.stack}`);
        res.status(500).send(`Proxy error: ${error.message}`);
    }
};
