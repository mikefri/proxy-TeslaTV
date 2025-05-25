// api/index.js
// Ceci est le code de votre fonction sans serveur Vercel

const fetch = require('node-fetch'); // Assurez-vous que node-fetch est bien installé dans vos dépendances (package.json)

module.exports = async (req, res) => {
    // Lire l'URL du flux à partir des paramètres de requête
    const { url } = req.query;

    if (!url) {
        return res.status(400).send('Missing "url" query parameter.');
    }

    try {
        // Décoder l'URL du flux
        const decodedUrl = decodeURIComponent(url);
        console.log(`[Proxy Vercel] Requête reçue pour le flux: ${decodedUrl}`);

        // Faire la requête au flux original
        const response = await fetch(decodedUrl);

        // Vérifier si la requête au flux original a échoué
        if (!response.ok) {
            console.error(`[Proxy Vercel] Erreur lors de la récupération du flux original: ${response.status} ${response.statusText}`);
            return res.status(response.status).send(`Failed to fetch original stream: ${response.statusText}`);
        }

        // --- Début des modifications pour la gestion des types de flux ---

        // Récupérer le Content-Type du flux original
        const contentType = response.headers.get('content-type');
        console.log(`[Proxy Vercel] Content-Type du flux original: ${contentType}`);

        // Si le Content-Type est déjà un HLS valide (application/x-mpegURL, application/vnd.apple.mpegurl, etc.)
        // ou si c'est un flux vidéo générique (video/mp2t, video/mpeg), on le renvoie tel quel.
        // HLS.js peut gérer directement les flux 'video/mp2t' si on lui dit de le faire (par le Content-Type).
        if (contentType && (
            contentType.includes('application/x-mpegurl') ||
            contentType.includes('application/vnd.apple.mpegurl') ||
            contentType.includes('video/mp2t') || // MPEG-TS
            contentType.includes('video/mpeg') ||  // MPEG
            contentType.includes('application/octet-stream') // Parfois utilisé pour des flux génériques
        )) {
            // Passer tous les en-têtes pertinents pour le streaming
            response.headers.forEach((value, name) => {
                // Filtrer les en-têtes qui ne devraient pas être transférés directement au client
                if (!['set-cookie', 'x-powered-by', 'alt-svc', 'transfer-encoding', 'connection'].includes(name.toLowerCase())) {
                    res.setHeader(name, value);
                }
            });
            console.log(`[Proxy Vercel] Renvoi du flux original directement avec Content-Type: ${contentType}`);
            // Envoyer le corps de la réponse directement
            response.body.pipe(res);
        } else {
            // Si le Content-Type n'est pas directement traitable par HLS.js ou est inconnu,
            // ou si on pense que c'est un flux brut que HLS.js devrait tenter de lire comme MPEG-TS.
            // On force le Content-Type à video/mp2t pour HLS.js, qui a un parser pour ça.
            // C'est une tentative de compatibilité pour les flux bruts.
            res.setHeader('Content-Type', 'video/mp2t');
            // Passer d'autres en-têtes utiles
            response.headers.forEach((value, name) => {
                if (!['set-cookie', 'x-powered-by', 'alt-svc', 'transfer-encoding', 'connection', 'content-type'].includes(name.toLowerCase())) {
                    res.setHeader(name, value);
                }
            });
            console.log(`[Proxy Vercel] Renvoi du flux en forçant Content-Type: video/mp2t`);
            response.body.pipe(res);
        }
        // --- Fin des modifications ---

    } catch (error) {
        console.error(`[Proxy Vercel] Erreur inattendue: ${error.message}`);
        res.status(500).send(`Proxy error: ${error.message}`);
    }
};