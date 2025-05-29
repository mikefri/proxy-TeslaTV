// api/index.js
const fetch = require('node-fetch'); // Assurez-vous que node-fetch est installé (npm install node-fetch)

module.exports = async (req, res) => {
    // --- Gestion des en-têtes CORS pour le client appelant le proxy ---
    // Ces en-têtes permettent à votre page web front-end (par ex. GitHub Pages) d'appeler ce proxy.
    res.setHeader('Access-Control-Allow-Origin', '*'); // Permet à n'importe quel domaine d'accéder. Pour plus de sécurité, utilisez 'https://mikefri.github.io' ou le domaine exact de votre site.
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, DELETE, OPTIONS'); // Ajoutez toutes les méthodes HTTP nécessaires
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Range, Authorization'); // Range et Authorization (si vous en utilisez) sont importants pour le streaming et l'authentification.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type'); // Expose des en-têtes supplémentaires nécessaires au client

    // Gérer les requêtes preflight OPTIONS (requêtes que le navigateur envoie avant la vraie requête GET/POST)
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
        requestHeaders['Accept-Encoding'] = 'identity'; // Demande une réponse non compressée

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
            // timeout: 0, // Pas de timeout (par défaut 0 pour node-fetch) - attention si le flux est très long à démarrer
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
        const originalContentType = response.headers.get('content-type');
        console.log(`[Proxy Vercel] Content-Type du flux original: ${originalContentType}`);

        // Définir les types MIME qui devraient être forcés à 'video/mp2t' (MPEG Transport Stream)
        // C'est crucial si le serveur de streaming renvoie un type générique comme 'application/octet-stream'.
        const typesToForceToMp2t = [
            'application/octet-stream', // C'est le cas problématique que vous avez rencontré avec xTeVe/Synology
            'binary/octet-stream',
            // Ajoutez d'autres types génériques si nécessaire
        ];

        // Définir les types MIME reconnus comme "bons" pour le streaming HLS/TS sans modification
        const goodStreamTypes = [
            'application/x-mpegurl',      // Pour les manifestes HLS (.m3u8)
            'application/vnd.apple.mpegurl', // Autre forme pour les manifestes HLS
            'video/mp2t',                 // Pour les segments MPEG-TS
            'video/mpeg',                 // Pour les flux MPEG
            'video/webm',                 // Pour les vidéos WebM
            'video/mp4'                   // Pour les vidéos MP4
        ];

        let finalContentType = originalContentType;

        // Si le type de contenu original est un de ceux que nous voulons forcer
        if (typesToForceToMp2t.includes(originalContentType)) {
            finalContentType = 'video/mp2t'; // Forcer spécifiquement à MPEG-TS
            console.log(`[Proxy Vercel] Forcing Content-Type de '${originalContentType}' à '${finalContentType}'`);
        } else if (!goodStreamTypes.includes(originalContentType) && originalContentType) {
            // Si le Content-Type n'est ni un type à forcer, ni un bon type, mais qu'il existe,
            // on pourrait logguer un avertissement ou décider de le laisser tel quel.
            // Pour l'instant, nous le laissons tel quel.
            console.warn(`[Proxy Vercel] Type de contenu inattendu '${originalContentType}', envoi tel quel. Vérification requise.`);
        }
        
        // Appliquer l'en-tête Content-Type final
        // Utiliser 'video/mp2t' comme fallback ultime si originalContentType est null/vide
        res.setHeader('Content-Type', finalContentType || 'video/mp2t');

        // --- Fin de la gestion Content-Type ---

        // Envoyer le corps de la réponse du flux original directement au client.
        // Cela permet un streaming efficace sans tamponner tout le flux en mémoire.
        response.body.pipe(res);

    } catch (error) {
        // Gérer les erreurs inattendues (problèmes réseau, DNS, erreurs SSL/certificats sur le serveur source, etc.)
        console.error(`[Proxy Vercel] Erreur inattendue: ${error.message} pour URL: ${decodedUrl}`);
        res.status(500).send(`Proxy error: ${error.message}`);
    }
};
