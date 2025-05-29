// api/index.js
const fetch = require('node-fetch');
const https = require('https'); // Nécessaire pour créer un agent HTTPS personnalisé

// Crée un agent HTTPS qui ignore les erreurs de certificat SSL/TLS.
// ATTENTION : Désactive la vérification du certificat SSL/TLS.
// C'est une faille de sécurité et n'est PAS recommandé pour la production.
const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

module.exports = async (req, res) => {
    // --- Gestion des en-têtes CORS pour le client appelant le proxy ---
    // Permet à votre page web front-end d'appeler ce proxy.
    res.setHeader('Access-Control-Allow-Origin', '*'); // Pour une sécurité accrue, remplacez '*' par votre domaine spécifique, ex: 'https://votredomaine.vercel.app'
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Range, Authorization');

    // Gérer les requêtes preflight OPTIONS (envoyées par le navigateur avant la vraie requête)
    if (req.method === 'OPTIONS') {
        return res.status(204).end(); // Répondre avec un statut 204 No Content
    }
    // --- Fin de la gestion CORS ---

    const { url } = req.query; // Récupère l'URL de destination du paramètre 'url'

    if (!url) {
        // Si le paramètre 'url' est manquant, retourner une erreur 400
        return res.status(400).send('Missing "url" query parameter.');
    }

    let decodedUrl; // Déclarée ici pour que sa portée englobe le bloc catch

    try {
        decodedUrl = decodeURIComponent(url); // Décode l'URL pour obtenir la cible réelle
        console.log(`[Proxy Vercel] Requête reçue pour le flux: ${decodedUrl}`);

        // --- Configuration des en-têtes pour la requête sortante vers le serveur de streaming ---
        const requestHeaders = {};

        // Définit un User-Agent de navigateur.
        // Vous pouvez essayer d'autres User-Agents si celui-ci est bloqué.
        // ex: 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Mobile/15E148 Safari/604.1'
        requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

        // Définit l'en-tête Referer. C'est SOUVENT la clé pour les erreurs 403 des flux vidéo.
        // - Si le flux est censé provenir d'un site spécifique (ex: un site officiel), mettez son URL ici.
        // - Sinon, vous pouvez essayer l'URL de votre propre proxy Vercel (https://votre-domaine-proxy.vercel.app).
        // - Ou l'URL de votre frontend (https://votredomaine.github.io).
        // Il faudra peut-être expérimenter avec différentes valeurs.
        requestHeaders['Referer'] = 'https://tesla-tv-proxy.vercel.app/'; // <<< À ajuster ou essayer d'autres valeurs

        // Transfère les autres en-têtes importants du client si présents
        if (req.headers['accept']) requestHeaders['Accept'] = req.headers['accept'];
        if (req.headers['accept-language']) requestHeaders['Accept-Language'] = req.headers['accept-language'];
        if (req.headers['range']) requestHeaders['Range'] = req.headers['range']; // Crucial pour le streaming et la recherche (seeking)

        // Surcharge de l'en-tête 'Host' pour qu'il corresponde au domaine de l'URL cible.
        // Cela peut aider le serveur cible à traiter la requête comme "légitime".
        requestHeaders['Host'] = new URL(decodedUrl).host;

        // Demande au serveur cible de ne pas compresser la réponse pour éviter des problèmes.
        requestHeaders['Accept-Encoding'] = 'identity';

        // Gérer la connexion pour qu'elle reste ouverte pour le streaming
        requestHeaders['Connection'] = 'keep-alive';

        // Si des en-têtes d'autorisation (Bearer token, etc.) sont nécessaires pour le flux IPTV,
        // assurez-vous de les transmettre également si le client vous les fournit.
        if (req.headers['authorization']) requestHeaders['Authorization'] = req.headers['authorization'];
        // --- Fin de la configuration des en-têtes ---

        // Exécuter la requête vers l'URL du flux original
        const response = await fetch(decodedUrl, {
            method: req.method, // Utilise la méthode de la requête originale (normalement GET)
            headers: requestHeaders, // Utilise les en-têtes que nous avons configurés
            // Utilise l'agent personnalisé pour les requêtes HTTPS afin de contourner les problèmes SSL/TLS
            agent: decodedUrl.startsWith('https://') ? httpsAgent : undefined
        });

        // Vérifier si la requête au flux original a réussi
        if (!response.ok) {
            console.error(`[Proxy Vercel] Erreur lors de la récupération du flux original: ${response.status} ${response.statusText} pour URL: ${decodedUrl}`);
            // Retourner le statut d'erreur du serveur original au client (ex: 403 Forbidden)
            return res.status(response.status).send(`Failed to fetch original stream: ${response.statusText}`);
        }

        // --- Transfert des en-têtes de la réponse originale au client ---
        // Exclure certains en-têtes qui ne devraient pas être transférés ou qui sont gérés par le proxy
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

        // Si c'est un manifeste HLS (M3U8), nous devons lire son contenu et réécrire les URLs internes.
        if (contentType && (contentType.includes('application/x-mpegurl') || contentType.includes('application/vnd.apple.mpegurl'))) {
            console.log('[Proxy Vercel] Manifeste HLS détecté. Réécriture des URLs...');
            const m3u8Content = await response.text(); // Lire le contenu du manifeste comme texte
            let modifiedM3u8Content = m3u8Content;

            // Déterminer l'URL de base du manifeste original pour pouvoir résoudre les chemins relatifs correctement.
            // Ex: si decodedUrl est "https://example.com/stream/playlist.m3u8", originalBaseUrl sera "https://example.com/stream/"
            const originalBaseUrl = new URL(decodedUrl).origin + new URL(decodedUrl).pathname.substring(0, new URL(decodedUrl).pathname.lastIndexOf('/') + 1);

            // Regex pour trouver et réécrire les URLs dans le manifeste HLS.
            // Elle cherche les lignes qui ne sont pas des commentaires (#) et qui ne sont pas déjà des URLs absolues (http/https).
            // Capture: URLs relatives (ex: 'segment123.ts') et absolues si elles ne commencent pas par http/https dans le manifeste lui-même.
            modifiedM3u8Content = modifiedM3u8Content.replace(
                /(^|\n)(?!#)(?!http:\/\/)(?!https:\/\/)([^\s,]+(\.(ts|m3u8|aac|mp4|jpg|png|key|mp3))?)/gm,
                (match, p1, p2) => {
                    let absoluteOriginalUrl;
                    try {
                        // Tente de construire une URL absolue à partir du chemin capturé (p2)
                        // et de l'URL de base du manifeste original.
                        absoluteOriginalUrl = new URL(p2, originalBaseUrl).href;
                    } catch (e) {
                        // En cas d'échec de la construction (ex: p2 est déjà une URL absolue ou malformée),
                        // utilise p2 tel quel.
                        absoluteOriginalUrl = p2;
                    }

                    // Retourne l'URL réécrite pour qu'elle passe par votre proxy Vercel.
                    // '/api' est le chemin de votre fonction Vercel.
                    return `${p1}/api?url=${encodeURIComponent(absoluteOriginalUrl)}`;
                }
            );

            // Définit le Content-Type approprié pour le manifeste M3U8
            res.setHeader('Content-Type', contentType);
            res.status(response.status).send(modifiedM3u8Content);

        } else {
            // Si ce n'est pas un manifeste HLS (par exemple, c'est un segment vidéo),
            // on passe le corps de la réponse directement au client.
            // On peut aussi forcer le Content-Type pour les segments TS si le serveur source ne le définit pas clairement.
            if (!contentType || (!contentType.includes('application/x-mpegurl') &&
                                !contentType.includes('application/vnd.apple.mpegurl') &&
                                !contentType.includes('video/mp2t') && // Type MIME pour MPEG Transport Stream (TS)
                                !contentType.includes('video/mpeg') &&
                                !contentType.includes('application/octet-stream'))) {
                res.setHeader('Content-Type', 'video/mp2t'); // Force au type MPEG-TS comme fallback
            } else {
                res.setHeader('Content-Type', contentType); // Garde le Content-Type original si valide
            }
            // Envoyer le corps de la réponse du flux original directement au client.
            // Cela permet un streaming efficace sans tamponner tout le flux en mémoire.
            response.body.pipe(res);
        }

    } catch (error) {
        // Gérer les erreurs inattendues (problèmes réseau, DNS, erreurs dans la logique du proxy, etc.)
        // La variable decodedUrl est maintenant accessible ici (même si elle est undefined en cas d'erreur très précoce)
        console.error(`[Proxy Vercel] Erreur inattendue: ${error.message} pour URL: ${decodedUrl || 'URL non définie'}`);
        res.status(500).send(`Proxy error: ${error.message}`);
    }
};
