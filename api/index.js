const fetch = require('node-fetch');

module.exports = async (req, res) => {
    // --- Gestion des en-têtes CORS pour le client appelant le proxy ---
    res.setHeader('Access-Control-Allow-Origin', '*'); // Ou 'https://votre-domaine.com' pour plus de sécurité
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Range, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    const { url } = req.query;

    if (!url) {
        return res.status(400).send('Missing "url" query parameter.');
    }

    try {
        const decodedUrl = decodeURIComponent(url);
        console.log(`[Proxy Vercel] Requête reçue pour le flux: ${decodedUrl}`);

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

        const response = await fetch(decodedUrl, {
            method: req.method,
            headers: requestHeaders,
        });

        if (!response.ok) {
            console.error(`[Proxy Vercel] Erreur lors de la récupération du flux original: ${response.status} ${response.statusText} pour URL: ${decodedUrl}`);
            return res.status(response.status).send(`Failed to fetch original stream: ${response.statusText}`);
        }

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

        const contentType = response.headers.get('content-type');
        console.log(`[Proxy Vercel] Content-Type du flux original: ${contentType}`);

        // --- NOUVELLE LOGIQUE : Réécriture des URLs pour les manifestes HLS ---
        if (contentType && (contentType.includes('application/x-mpegurl') || contentType.includes('application/vnd.apple.mpegurl'))) {
            console.log('[Proxy Vercel] Manifeste HLS détecté. Réécriture des URLs...');
            const m3u8Content = await response.text();
            let modifiedM3u8Content = m3u8Content;

            // Base URL of the original manifest to resolve relative paths
            const originalBaseUrl = new URL(decodedUrl).origin + new URL(decodedUrl).pathname.substring(0, new URL(decodedUrl).pathname.lastIndexOf('/') + 1);

            // Regex pour trouver les URLs dans le manifeste HLS
            // Cela couvre les segments (.ts, .aac, etc.), les sous-manifestes (.m3u8)
            // et gère les chemins relatifs.
            // La regex est simplifiée et pourrait nécessiter des ajustements pour tous les cas HLS.
            modifiedM3u8Content = modifiedM3u8Content.replace(
                /^(?!#)(?!http:\/\/)(?!https:\/\/)([^\s,]+(\.(ts|m3u8|aac|mp4|jpg|png|key))?)/gm,
                (match, p1) => {
                    let absoluteOriginalUrl;
                    try {
                        // Tenter de construire une URL absolue.
                        // new URL(relativePath, baseUrl) est très utile ici.
                        absoluteOriginalUrl = new URL(p1, originalBaseUrl).href;
                    } catch (e) {
                        // Si p1 est déjà une URL absolue valide ou un cas non géré par new URL,
                        // on l'utilise telle quelle.
                        absoluteOriginalUrl = p1;
                    }

                    // Retourner l'URL proxifiée
                    return `/api?url=${encodeURIComponent(absoluteOriginalUrl)}`;
                }
            );

            // Définir le Content-Type approprié pour le manifeste M3U8
            res.setHeader('Content-Type', contentType);
            res.status(response.status).send(modifiedM3u8Content);

        } else {
            // Si ce n'est pas un manifeste HLS, ou un autre type de media,
            // on passe le corps directement.
            if (!contentType || (!contentType.includes('video/mp2t') &&
                                !contentType.includes('video/mpeg') &&
                                !contentType.includes('application/octet-stream'))) {
                res.setHeader('Content-Type', 'video/mp2t'); // Fallback pour les segments TS non clairement identifiés
            } else {
                res.setHeader('Content-Type', contentType); // Garde le Content-Type original si valide
            }
            response.body.pipe(res);
        }

    } catch (error) {
        console.error(`[Proxy Vercel] Erreur inattendue: ${error.message} pour URL: ${decodedUrl}`);
        res.status(500).send(`Proxy error: ${error.message}`);
    }
};
