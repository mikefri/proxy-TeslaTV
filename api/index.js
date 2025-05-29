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
        return res.status(204).end();
    }

    const { url } = req.query;

    if (!url) {
        return res.status(400).send('Missing "url" query parameter.');
    }

    let decodedUrl;

    try {
        decodedUrl = decodeURIComponent(url);
        console.log(`[Proxy Vercel] Requête reçue pour le flux: ${decodedUrl}`);

        const useHttpsAgent = decodedUrl.startsWith('https://');

        const requestHeaders = {};
        requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
        requestHeaders['Referer'] = 'https://tesla-tv-proxy.vercel.app/'; // N'oubliez pas d'ajuster si nécessaire
        if (req.headers['accept']) requestHeaders['Accept'] = req.headers['accept'];
        if (req.headers['accept-language']) requestHeaders['Accept-language'] = req.headers['accept-language'];
        if (req.headers['range']) requestHeaders['Range'] = req.headers['range'];
        if (req.headers['authorization']) requestHeaders['Authorization'] = req.headers['authorization'];

        requestHeaders['Host'] = new URL(decodedUrl).host;
        requestHeaders['Accept-Encoding'] = 'identity';
        requestHeaders['Connection'] = 'keep-alive';

        const response = await fetch(decodedUrl, {
            method: req.method,
            headers: requestHeaders,
            agent: useHttpsAgent ? httpsAgent : undefined
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

        const isHlsManifest = (contentType && (
            contentType.includes('application/x-mpegurl') ||
            contentType.includes('application/vnd.apple.mpegurl') ||
            (contentType.includes('text/plain') && decodedUrl.endsWith('.m3u8'))
        ));

        if (isHlsManifest) {
            console.log('[Proxy Vercel] Manifeste HLS détecté. Réécriture des URLs...');
            const m3u8Content = await response.text();
            let modifiedM3u8Content = m3u8Content;

            // Détermine l'URL de base pour résoudre les chemins relatifs.
            // S'assure que l'originalBaseUrl se termine toujours par un '/' pour la résolution des chemins.
            const originalBaseUrl = new URL(decodedUrl).protocol + '//' + new URL(decodedUrl).host + new URL(decodedUrl).pathname.substring(0, new URL(decodedUrl).pathname.lastIndexOf('/') + 1);

            // Regex améliorée pour cibler les URLs dans les deux formats de manifestes.
            // Elle cherche une URL qui:
            // 1. Est le contenu d'une ligne seule (segments, clés, etc.)
            // 2. Est précédée par une directive comme #EXT-X-STREAM-INF:URI= ou #EXT-X-MEDIA:URI=
            // 3. Est précédée par un #EXTINF: et suivie par une virgule (pour les segments vidéo/audio)
            modifiedM3u8Content = modifiedM3u8Content.replace(
                /(^|\n)([^#\n]+?)(?=\s|$)|(URI=")([^"]+?)(")|(#EXTINF:[^,\n]+,\s*)([^\n]+)/g,
                (match, p1, p2_standalone, p3_uri_prefix, p4_uri_path, p5_uri_suffix, p6_extinf_prefix, p7_extinf_path) => {
                    let originalPath = '';
                    if (p2_standalone) { // Cas 1: URL autonome sur une ligne (ex: ../segment.mp4)
                        originalPath = p2_standalone.trim();
                    } else if (p4_uri_path) { // Cas 2: URI dans une directive (URI="...")
                        originalPath = p4_uri_path.trim();
                    } else if (p7_extinf_path) { // Cas 3: URL après #EXTINF:
                        originalPath = p7_extinf_path.trim();
                    }

                    // Si le chemin est vide, un commentaire HLS, ou déjà une URL de proxy, ou une URL "data:", le laisser tel quel.
                    // La vérification !originalPath.match(/^(https?:\/\/|data:)/) est cruciale pour ne pas retoucher les URLs absolues déjà présentes.
                    if (!originalPath || originalPath.startsWith('#') || originalPath.startsWith('/api?url=') || originalPath.match(/^(https?:\/\/|data:)/)) {
                        return match;
                    }

                    let absoluteOriginalUrl;
                    try {
                        // Tente de construire une URL absolue.
                        // La méthode URL() gère correctement les chemins absolus et relatifs par rapport à originalBaseUrl.
                        absoluteOriginalUrl = new URL(originalPath, originalBaseUrl).href;
                    } catch (e) {
                        console.error("[Proxy Vercel] Erreur de construction d'URL absolue:", e.message, "pour chemin:", originalPath);
                        absoluteOriginalUrl = originalPath; // Fallback au cas où l'URL ne peut pas être absolutisée
                    }
                    
                    // Si l'URL originale était déjà absolue et n'a pas été capturée par la condition ci-dessus
                    // (ce qui ne devrait pas arriver avec la regex actuelle, mais par sécurité)
                    // Il faut s'assurer de ne pas double-proxy.
                    if (absoluteOriginalUrl.startsWith(req.headers.host) && absoluteOriginalUrl.includes('/api?url=')) {
                        return match; // C'est déjà une URL proxyfiée, on ne la touche pas.
                    }

                    const proxifiedUrl = `/api?url=${encodeURIComponent(absoluteOriginalUrl)}`;

                    if (p2_standalone) {
                        return `${p1}${proxifiedUrl}`;
                    } else if (p4_uri_path) {
                        return `${p3_uri_prefix}${proxifiedUrl}${p5_uri_suffix}`;
                    } else if (p7_extinf_path) {
                        return `${p6_extinf_prefix}${proxifiedUrl}`;
                    }
                    return match; // Ne devrait pas arriver
                }
            );

            res.setHeader('Content-Type', 'application/x-mpegurl'); // Ou 'application/vnd.apple.mpegurl'
            res.status(response.status).send(modifiedM3u8Content);

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

            response.body.pipe(res);
        }

    } catch (error) {
        console.error(`[Proxy Vercel] Erreur inattendue: ${error.message} pour URL: ${decodedUrl || 'URL non définie'}`);
        res.status(500).send(`Proxy error: ${error.message}`);
    }
};