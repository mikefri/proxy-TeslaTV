// api/index.js
const fetch = require('node-fetch');
const https = require('https'); // Gardez-le au cas où le proxy serait appelé avec une URL HTTPS par erreur, ou pour d'autres usages.

// Crée un agent HTTPS qui ignore les erreurs de certificat SSL/TLS.
// Il sera utilisé si la 'decodedUrl' que le proxy doit fetch est elle-même en HTTPS.
// Gardez-le, car votre frontend pourrait envoyer des URLs HTTPS au proxy par erreur,
// ou si vous changez d'avis plus tard.
const httpsAgent = new https.Agent({
    rejectUnauthorized: false // ATTENTION : Vulnérabilité de sécurité
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

        // --- Vérification cruciale : Si l'URL à charger par le proxy est HTTPS, n'utilisez pas l'agent spécial ---
        // ATTENTION : Si votre FRONTEND n'envoie au proxy QUE des URL HTTP, cette vérification est moins critique,
        // mais elle assure que le proxy ne contourne pas la sécurité SSL pour les URL HTTPS si elles lui sont envoyées.
        const useHttpsAgent = decodedUrl.startsWith('https://'); 
        
        // --- Configuration des en-têtes pour la requête sortante vers le serveur de streaming ---
        const requestHeaders = {};

        // Définit un User-Agent de navigateur (expérimentez avec différentes valeurs si le 403 persiste)
        requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
        // Exemple d'autres User-Agents à tester:
        // requestHeaders['User-Agent'] = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'; // iOS
        // requestHeaders['User-Agent'] = 'Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Mobile Safari/537.36'; // Android


        // Définit l'en-tête Referer (expérimentez avec différentes valeurs si le 403 persiste)
        // C'est SOUVENT la clé pour les erreurs 403 des flux vidéo.
        requestHeaders['Referer'] = 'https://tesla-tv-proxy.vercel.app/'; // Votre domaine de proxy ou de frontend
        // Exemples d'autres Referer à tester:
        // requestHeaders['Referer'] = 'https://www.legitimate-stream-site.com/'; // Si vous connaissez le site d'où le flux est censé provenir
        // requestHeaders['Referer'] = ''; // Referer vide
        // delete requestHeaders['Referer']; // Ne pas envoyer d'en-tête Referer du tout


        // Transfère les autres en-têtes importants du client si présents
        if (req.headers['accept']) requestHeaders['Accept'] = req.headers['accept'];
        if (req.headers['accept-language']) requestHeaders['Accept-language'] = req.headers['accept-language'];
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
            // NOUVEAU : utilise l'agent personnalisé SEULEMENT si l'URL à charger par le proxy est HTTPS
            // et que nous voulons contourner la vérification SSL/TLS pour cette requête.
            agent: useHttpsAgent ? httpsAgent : undefined 
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

        // Si c'est un manifeste HLS (M3U8), nous devons lire son contenu et réécrire les URLs internes.
        if (contentType && (contentType.includes('application/x-mpegurl') || contentType.includes('application/vnd.apple.mpegurl'))) {
            console.log('[Proxy Vercel] Manifeste HLS détecté. Réécriture des URLs...');
            const m3u8Content = await response.text();
            let modifiedM3u8Content = m3u8Content;

            const originalBaseUrl = new URL(decodedUrl).origin + new URL(decodedUrl).pathname.substring(0, new URL(decodedUrl).pathname.lastIndexOf('/') + 1);

            modifiedM3u8Content = modifiedM3u8Content.replace(
                /(^|\n)(?!#)(?!http:\/\/)(?!https:\/\/)([^\s,]+(\.(ts|m3u8|aac|mp4|jpg|png|key|mp3))?)/gm,
                (match, p1, p2) => {
                    let absoluteOriginalUrl;
                    try {
                        absoluteOriginalUrl = new URL(p2, originalBaseUrl).href;
                    } catch (e) {
                        absoluteOriginalUrl = p2;
                    }
                    // IMPORTANT : Lorsque vous réécrivez, si l'URL ABSOLUE est HTTPS,
                    // vous voudrez toujours qu'elle passe par le proxy si elle vient d'un HTTP initial.
                    // Sinon, le navigateur pourrait tenter de la charger directement et être bloqué par CORS.
                    // Donc, la réécriture vers le proxy est toujours la bonne approche ici.
                    return `${p1}/api?url=${encodeURIComponent(absoluteOriginalUrl)}`;
                }
            );

            res.setHeader('Content-Type', contentType);
            res.status(response.status).send(modifiedM3u8Content);

        } else {
            // Si ce n'est pas un manifeste HLS (par exemple, c'est un segment vidéo),
            // on passe le corps de la réponse directement au client.
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
