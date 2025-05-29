// api/index.js
const fetch = require('node-fetch'); // Assurez-vous que node-fetch est installé (npm install node-fetch)

module.exports = async (req, res) => {
    // --- Gestion des en-têtes CORS pour le client appelant le proxy ---
    // Ces en-têtes permettent à votre page web front-end d'appeler ce proxy.
    res.setHeader('Access-Control-Allow-Origin', '*'); // Permet à n'importe quel domaine d'accéder. Pour plus de sécurité, utilisez 'https://mikefri.github.io' ou le domaine exact de votre site.
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, DELETE, OPTIONS'); // Ajoutez toutes les méthodes HTTP nécessaires
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Range, Authorization'); // Range et Authorization (si vous en utilisez) sont importants pour le streaming et l'authentification.

    // Gérer les requêtes preflight OPTIONS (requêtes que le navigateur envoie avant la vraie requête)
    if (req.method === 'OPTIONS') {
        return res.status(204).end(); // Répondre avec un statut 204 No Content
    }
    // --- Fin de la gestion CORS ---


    const { url } = req.query; // Récupère l'URL de destination du paramètre 'url'

    if (!url) {
        // Si le paramètre 'url' est manquant, retourner une erreur 400
        return res.status(400).send('Missing "url" query parameter.');
    }

    let decodedUrl; // <<< CORRECTION ICI : Déclarez decodedUrl en dehors du try pour sa portée

    try {
        decodedUrl = decodeURIComponent(url); // Décode l'URL pour obtenir la cible réelle
        console.log(`[Proxy Vercel] Requête reçue pour le flux: ${decodedUrl}`);

        // --- Configuration des en-têtes pour la requête sortante vers le serveur de streaming ---
        const requestHeaders = {};

        // Copier certains en-têtes utiles de la requête du client
        if (req.headers['user-agent']) requestHeaders['User-Agent'] = req.headers['user-agent'];
        else requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

        if (req.headers['referer']) requestHeaders['Referer'] = req.headers['referer'];
        if (req.headers['accept']) requestHeaders['Accept'] = req.headers['accept'];
        if (req.headers['accept-language']) requestHeaders['Accept-Language'] = req.headers['accept-language'];
        if (req.headers['range']) requestHeaders['Range'] = req.headers['range']; // Crucial pour le streaming

        // Surcharge de l'en-tête 'Host' pour qu'il corresponde au domaine de l'URL cible.
        // Cela évite que le serveur cible ne pense que la requête vient du proxy Vercel.
        requestHeaders['Host'] = new URL(decodedUrl).host;

        // Important pour éviter des problèmes de compression double ou de décodage côté client.
        requestHeaders['Accept-Encoding'] = 'identity';

        // Gérer la connexion pour qu'elle reste ouverte pour le streaming
        requestHeaders['Connection'] = 'keep-alive';

        // Si des en-têtes d'autorisation sont nécessaires pour le flux IPTV
        if (req.headers['authorization']) requestHeaders['Authorization'] = req.headers['authorization'];
        // --- Fin de la configuration des en-têtes ---

        // Exécuter la requête vers l'URL du flux original
        const response = await fetch(decodedUrl, {
            method: req.method, // Utiliser la méthode de la requête originale (normalement GET)
            headers: requestHeaders, // Utiliser les en-têtes que nous avons configurés
        });

        // Vérifier si la requête au flux original a réussi
        if (!response.ok) {
            console.error(`[Proxy Vercel] Erreur lors de la récupération du flux original: ${response.status} ${response.statusText} pour URL: ${decodedUrl}`);
            // Retourner le statut d'erreur du serveur original au client
            return res.status(response.status).send(`Failed to fetch original stream: ${response.statusText}`);
        }

        // --- Transfert des en-têtes de la réponse originale au client ---
        const headersToExclude = [
            'set-cookie', 'x-powered-by', 'alt-svc', 'transfer-encoding', 'connection',
            'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers',
            'content-encoding' // Exclure si Accept-Encoding: 'identity' a été utilisé
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
            const m3u8Content = await response.text(); // Lire le contenu du manifeste comme texte
            let modifiedM3u8Content = m3u8Content;

            // Déterminer l'URL de base du manifeste original pour résoudre les chemins relatifs
            // ex: si decodedUrl est https://example.com/stream/playlist.m3u8, baseUrl sera https://example.com/stream/
            const originalBaseUrl = new URL(decodedUrl).origin + new URL(decodedUrl).pathname.substring(0, new URL(decodedUrl).pathname.lastIndexOf('/') + 1);

            // Regex pour trouver les URLs dans le manifeste HLS (segments, sous-manifestes)
            // On cherche des lignes qui ne sont ni des commentaires (#), ni des URLs absolues (http/https),
            // et qui se terminent par des extensions de fichiers HLS typiques.
            modifiedM3u8Content = modifiedM3u8Content.replace(
                // Capture:
                // 1. Les URLs relatives (ex: 'segment123.ts', '../alternate/playlist.m3u8')
                // 2. Les URLs absolues (ex: 'https://cdn.example.com/segment456.ts')
                // et assure que nous ne modifions pas les lignes de tags HLS (#EXTINF, #EXT-X-VERSION, etc.)
                /(^|\n)(?!#)(?!http:\/\/)(?!https:\/\/)([^\s,]+(\.(ts|m3u8|aac|mp4|jpg|png|key|mp3))?)/gm,
                (match, p1, p2) => {
                    let absoluteOriginalUrl;
                    try {
                        // Tenter de construire une URL absolue à partir du chemin capturé (p2)
                        // et de l'URL de base du manifeste original.
                        absoluteOriginalUrl = new URL(p2, originalBaseUrl).href;
                    } catch (e) {
                        // Si la construction échoue (ex: p2 est déjà une URL absolue valide ou malformée),
                        // on utilise p2 tel quel. (Devrait être rare avec la regex ci-dessus si elle est bien formée)
                        absoluteOriginalUrl = p2;
                    }

                    // Retourner l'URL réécrite pour qu'elle passe par le proxy Vercel.
                    // '/api' est le chemin de votre fonction Vercel.
                    return `${p1}/api?url=${encodeURIComponent(absoluteOriginalUrl)}`;
                }
            );

            // Définir le Content-Type approprié pour le manifeste M3U8
            res.setHeader('Content-Type', contentType);
            res.status(response.status).send(modifiedM3u8Content);

        } else {
            // Si ce n'est pas un manifeste HLS (c'est probablement un segment vidéo),
            // on passe le corps directement.
            // On peut aussi forcer le Content-Type pour les segments TS si nécessaire.
            if (!contentType || (!contentType.includes('application/x-mpegurl') &&
                                !contentType.includes('application/vnd.apple.mpegurl') &&
                                !contentType.includes('video/mp2t') && // MPEG-TS
                                !contentType.includes('video/mpeg') &&
                                !contentType.includes('application/octet-stream'))) {
                res.setHeader('Content-Type', 'video/mp2t'); // Force au type MPEG-TS comme fallback
            } else {
                res.setHeader('Content-Type', contentType); // Garde le Content-Type original si valide
            }
            // Envoyer le corps de la réponse du flux original directement au client.
            response.body.pipe(res);
        }

    } catch (error) {
        // Gérer les erreurs inattendues (problèmes réseau, DNS, erreurs dans la logique, etc.)
        // La variable decodedUrl est maintenant accessible ici (même si elle est undefined en cas d'erreur très précoce)
        console.error(`[Proxy Vercel] Erreur inattendue: ${error.message} pour URL: ${decodedUrl || 'URL non définie'}`);
        res.status(500).send(`Proxy error: ${error.message}`);
    }
};
