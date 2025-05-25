// api/index.js (Version CONCEPTUELLE pour la transmuxing basique)

const fetch = require('node-fetch');

module.exports = async (req, res) => {
    const { url, segment } = req.query; // 'segment' serait un nouveau paramètre

    if (!url) {
        return res.status(400).send('Missing "url" query parameter.');
    }

    const decodedUrl = decodeURIComponent(url);
    console.log(`[Proxy Vercel] Requête reçue pour le flux: ${decodedUrl}`);

    // LOGIQUE DE TRANSMUXING SIMPLIFIÉE (très expérimentale)
    // Ceci est un POC, non garanti de fonctionner avec tous les flux ou avec HLS.js sans erreurs.
    // L'idée est de faire croire à HLS.js qu'il y a un manifeste.

    // Si la requête est pour le manifeste principal (pas de paramètre 'segment')
    if (!segment) {
        // Le proxy va générer un manifeste HLS simple
        res.setHeader('Content-Type', 'application/x-mpegURL'); // Type MIME pour HLS
        res.status(200).send(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:10.0,
${req.protocol}://${req.headers.host}${req.originalUrl}&segment=1 // Pointe vers lui-même avec un paramètre segment
#EXT-X-ENDLIST`);
        console.log(`[Proxy Vercel] Manifeste HLS généré pour: ${decodedUrl}`);
    } else if (segment === '1') {
        // Si la requête est pour le "segment" (en fait, le flux entier)
        try {
            const response = await fetch(decodedUrl);

            if (!response.ok) {
                console.error(`[Proxy Vercel] Erreur lors de la récupération du flux original (segment): ${response.status} ${response.statusText}`);
                return res.status(response.status).send(`Failed to fetch original stream: ${response.statusText}`);
            }

            // Renvoie le flux MPEG-TS direct
            res.setHeader('Content-Type', 'video/mp2t'); // Type MIME pour MPEG-TS
            response.headers.forEach((value, name) => {
                if (!['set-cookie', 'x-powered-by', 'alt-svc', 'transfer-encoding', 'connection', 'content-type'].includes(name.toLowerCase())) {
                    res.setHeader(name, value);
                }
            });
            console.log(`[Proxy Vercel] Renvoi du flux MPEG-TS pour le "segment": ${decodedUrl}`);
            response.body.pipe(res);

        } catch (error) {
            console.error(`[Proxy Vercel] Erreur inattendue lors de la récupération du segment: ${error.message}`);
            res.status(500).send(`Proxy error: ${error.message}`);
        }
    } else {
        res.status(404).send('Segment not found');
    }
};