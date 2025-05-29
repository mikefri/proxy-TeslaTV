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

    try {
        const decodedUrl = decodeURIComponent(url); // Décode l'URL pour obtenir la cible réelle
        console.log(`[Proxy Vercel] Requête reçue pour le flux: ${decodedUrl}`);

        // --- Configuration des en-têtes pour la requête sortante vers le serveur de streaming ---
        const requestHeaders = {};

        // Copier certains en-têtes utiles de la requête du client
        // Ces en-têtes peuvent aider le serveur de streaming à identifier la requête comme "légitime"
        if (req.headers['user-agent']) requestHeaders['User-Agent'] = req.headers['user-agent'];
        else requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'; // Fallback pour un User-Agent de navigateur commun

        if (req.headers['referer']) requestHeaders['Referer'] = req.headers['referer'];
        if (req.headers['accept']) requestHeaders['Accept'] = req.headers['accept'];
        if (req.headers['accept-language']) requestHeaders['Accept-Language'] = req.headers['accept-language'];
        if (req.headers['range']) requestHeaders['Range'] = req.headers['range']; // Crucial pour le streaming et la recherche (seeking)

        // Surcharge de l'en-tête 'Host' pour qu'il corresponde au domaine de l'URL cible,
        // cela évite que le serveur cible ne pense que la requête vient du proxy Vercel.
        requestHeaders['Host'] = new URL(decodedUrl).host;

        // Important pour éviter des problèmes de compression double ou de décodage côté client.
        // On demande au serveur cible de ne pas compresser la réponse.
        requestHeaders['Accept-Encoding'] = 'identity';

        // Gérer la connexion pour qu'elle reste ouverte pour le streaming
        requestHeaders['Connection'] = 'keep-alive';

        // Si des en-têtes d'autorisation (Bearer token, etc.) sont nécessaires pour le flux IPTV,
        // assurez-vous de les transmettre également si le client vous les fournit.
        if (req.headers['authorization']) requestHeaders['Authorization'] = req.headers['authorization'];
        // --- Fin de la configuration des en-têtes ---

        // Exécuter la requête vers l'URL du flux original
        const response = await fetch(decodedUrl, {
            method: req.method, // Utiliser la méthode de la requête originale (normalement GET)
            headers: requestHeaders, // Utiliser les en-têtes que nous avons configurés
            // Optionnel: si vous avez des problèmes de redirection ou de certificats
            // follow: 20, // Nombre max de redirections à suivre (par défaut 20)
            // timeout: 0, // Pas de timeout (par défaut 0 pour node-fetch)
            // compress: false, // Désactiver la décompression automatique si vous voulez gérer cela manuellement
        });

        // Vérifier si la requête au flux original a réussi
        if (!response.ok) {
            console.error(`[Proxy Vercel] Erreur lors de la récupération du flux original: ${response.status} ${response.statusText} pour URL: ${decodedUrl}`);
            // Retourner le statut d'erreur du serveur original au client
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


        // --- Gestion spécifique du Content-Type pour le streaming ---
        // Cette logique vise à garantir que le navigateur sache comment interpréter le flux.
        const contentType = response.headers.get('content-type');
        console.log(`[Proxy Vercel] Content-Type du flux original: ${contentType}`);

        // Si le Content-Type n'est pas directement un type MIME reconnu pour HLS ou TS,
        // on peut tenter de le forcer à 'video/mp2t' pour aider hls.js ou le lecteur natif.
        // Cela est utile si le serveur de streaming renvoie un 'application/octet-stream' générique par exemple.
        if (!contentType || (!contentType.includes('application/x-mpegurl') &&
                            !contentType.includes('application/vnd.apple.mpegurl') &&
                            !contentType.includes('video/mp2t') &&
                            !contentType.includes('video/mpeg') &&
                            !contentType.includes('application/octet-stream'))) {
            res.setHeader('Content-Type', 'video/mp2t'); // Force au type MPEG-TS
        } else {
            res.setHeader('Content-Type', contentType); // Garde le Content-Type original si valide
        }
        // --- Fin de la gestion Content-Type ---

        // Envoyer le corps de la réponse du flux original directement au client.
        // Cela permet un streaming efficace sans tamponner tout le flux en mémoire.
        response.body.pipe(res);

    } catch (error) {
        // Gérer les erreurs inattendues (problèmes réseau, DNS, etc.)
        console.error(`[Proxy Vercel] Erreur inattendue: ${error.message} pour URL: ${decodedUrl}`);
        res.status(500).send(`Proxy error: ${error.message}`);
    }
};
