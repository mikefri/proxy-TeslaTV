// api/index.js
const fetch = require('node-fetch');
const https = require('https'); // <<< NOUVEAU : Importe le module https

// Crée un agent HTTPS qui ignore les erreurs de certificat SSL/TLS
const agent = new https.Agent({
    rejectUnauthorized: false // <<< ATTENTION : Ceci désactive la vérification du certificat SSL/TLS
});

module.exports = async (req, res) => {
    // --- Gestion des en-têtes CORS pour le client appelant le proxy ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Range, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    // --- Fin de la gestion CORS ---

    const { url } = req.query;

    if (!url) {
        return res.status(400).send('Missing "url" query parameter.');
    }

    let decodedUrl; 

    try {
        decodedUrl = decodeURIComponent(url);
        console.log(`[Proxy Vercel] Requête reçue pour le flux: ${decodedUrl}`);

        // --- Configuration des en-têtes pour la requête sortante vers le serveur de streaming ---
        const requestHeaders = {};
        if (req.headers['user-agent']) requestHeaders['User-Agent'] = req.headers['user-agent'];
        else requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

        if (req.headers['referer']) requestHeaders['Referer'] = req.headers['referer'];
        if (req.headers['accept']) requestHeaders['Accept'] = req.headers['accept'];
        if (req.headers['accept-language']) requestHeaders['Accept-Language'] = req.headers['accept-language'];
        if (req.headers['range']) requestHeaders['Range'] = req.headers['range'];

        requestHeaders['Host'] = new URL(decodedUrl).host;
        requestHeaders['Accept-Encoding'] = 'identity';
        requestHeaders['Connection'] = 'keep-alive';
        if (req.headers['authorization']) requestHeaders['Authorization'] = req.headers['authorization'];
        // --- Fin de la configuration des en-têtes ---

        // Exécuter la requête vers l'URL du flux original
        const response = await fetch(decodedUrl, {
            method: req.method,
            headers: requestHeaders,
            agent: decodedUrl.startsWith('https://') ? agent : undefined // <<< MODIFICATION ICI : Utilise l'agent pour les requêtes HTTPS
        });

        // Vérifier si la requête au flux original a réussi
        if (!response.ok) {
            console.error(`[Proxy Vercel] Erreur lors de la récupération du flux original: ${response.status} ${response.statusText} pour URL: ${decodedUrl}`);
            return res.status(response.status).send(`Failed to fetch original stream: ${response.statusText}`);
        }

        // --- Transfert des en-têtes de la réponse originale au client ---
        const headersToExclude = [
            'set-cookie', 'x-powered-by', 'alt-svc', 'transfer-encoding', 'connection',
            'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers',
            'content-encoding'
        ];

        response.headers.forEach((value, name) => {
            if (!headersToExclude.includes(name.toLowerCase())) {
                res.setHeader(name, value);
            }
        });
        // --- Fin du transfert des en-têtes ---


        // --- Gestion spécifique du Content-Type et réécriture pour le streaming HLS ---
        const contentType = response.headers.get('content-type');
        console.log(`[Proxy Vercel] Content-Type du flux original: ${contentType}`);

        // Si c'est un manifeste HLS, nous devons lire son contenu et réécrire les URLs
        if (contentType && (contentType.includes('application/x-mpegurl') || contentType.includes('application/vnd.apple.mpegurl'))) {
            console.log('[Proxy Vercel] Manifeste HLS détecté. Réécriture des URLs...');
            const m3u8Content = await response.text();
            let modifiedM3u8Content = m3u8Content;

            // Déterminer l'URL de base du manifeste original pour résoudre les chemins relatifs
            const originalBaseUrl = new URL(decodedUrl).origin + new URL(decodedUrl).pathname.substring(0, new URL(decodedUrl).pathname.lastIndexOf('/') + 1);

            // Regex pour trouver les URLs dans le manifeste HLS (segments, sous-manifestes)
            modifiedM3u8Content = modifiedM3u8Content.replace(
                /(^|\n)(?!#)(?!http:\/\/)(?!https:\/\/)([^\s,]+(\.(ts|m3u8|aac|mp4|jpg|png|key|mp3))?)/gm,
                (match, p1, p2) => {
                    let absoluteOriginalUrl;
                    try {
                        absoluteOriginalUrl = new URL(p2, originalBaseUrl).href;
                    } catch (e) {
                        absoluteOriginalUrl = p2;
                    }

                    return `${p1}/api?url=${encodeURIComponent(absoluteOriginalUrl)}`;
                }
            );

            res.setHeader('Content-Type', contentType);
            res.status(response.status).send(modifiedM3u8Content);

        } else {
            // Si ce n'est pas un manifeste HLS, on passe le corps directement.
            if (!contentType || (!contentType.includes('application/x-mpegurl') &&
                                !contentType.includes('application/vnd.apple.mpegurl') &&
                                !contentType.includes('video/mp2t') &&
                                !contentType.includes('video/mpeg') &&
                                !contentType.includes('application/octet-stream'))) {
                res.setHeader('Content-Type', 'video/mp2t');
            } else {
                res.setHeader('Content-Type', contentType);
            }
            response.body.pipe(res);
        }

    } catch (error) {
        console.error(`[Proxy Vercel] Erreur inattendue: ${error.message} pour URL: ${decodedUrl || 'URL non définie'}`);
        res.status(500).send(`Proxy error: ${error.message}`);
    }
};
