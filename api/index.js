// api/index.js
const fetch = require('node-fetch');

module.exports = async (req, res) => {
    // AJOUTEZ CETTE LIGNE EN PREMIER pour gérer le CORS
    res.setHeader('Access-Control-Allow-Origin', '*'); // Permet à n'importe quel domaine d'accéder. Pour plus de sécurité, utilisez 'https://mikefri.github.io'
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Range'); // Range est important pour le streaming

    // Gérer les requêtes preflight OPTIONS (requêtes que le navigateur envoie avant la vraie requête)
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

        const response = await fetch(decodedUrl);

        if (!response.ok) {
            console.error(`[Proxy Vercel] Erreur lors de la récupération du flux original: ${response.status} ${response.statusText}`);
            return res.status(response.status).send(`Failed to fetch original stream: ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type');
        console.log(`[Proxy Vercel] Content-Type du flux original: ${contentType}`);

        // Passer d'autres en-têtes utiles de la réponse originale
        response.headers.forEach((value, name) => {
            // Filtrer les en-têtes qui ne devraient pas être transférés directement au client
            // Et ne pas écraser les en-têtes CORS que nous venons de définir
            if (!['set-cookie', 'x-powered-by', 'alt-svc', 'transfer-encoding', 'connection', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers'].includes(name.toLowerCase())) {
                res.setHeader(name, value);
            }
        });

        // La logique de Content-Type que nous avions avant
        if (!contentType || (!contentType.includes('application/x-mpegurl') &&
                            !contentType.includes('application/vnd.apple.mpegurl') &&
                            !contentType.includes('video/mp2t') &&
                            !contentType.includes('video/mpeg') &&
                            !contentType.includes('application/octet-stream'))) {
            // Si le Content-Type n'est pas directement traitable par HLS.js ou est inconnu,
            // ou si on pense que c'est un flux brut que HLS.js devrait tenter de lire comme MPEG-TS.
            // On force le Content-Type à video/mp2t pour HLS.js, qui a un parser pour ça.
            // C'est une tentative de compatibilité pour les flux bruts.
            res.setHeader('Content-Type', 'video/mp2t');
        } else {
            res.setHeader('Content-Type', contentType); // Garder le Content-Type original si valide
        }


        // Envoyer le corps de la réponse directement
        response.body.pipe(res);

    } catch (error) {
        console.error(`[Proxy Vercel] Erreur inattendue: ${error.message}`);
        res.status(500).send(`Proxy error: ${error.message}`);
    }
};