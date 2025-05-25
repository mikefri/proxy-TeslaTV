// api/index.js
// Ce script est le cœur de votre proxy Vercel, utilisant Axios pour plus de robustesse.

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

// Route pour le manifeste HLS généré (si l'URL source est un .ts)
app.get('/api', async (req, res) => {
    const originalStreamUrl = req.query.url;

    if (!originalStreamUrl) {
        console.log('[Proxy Vercel] Erreur: Le paramètre "url" est manquant.');
        return res.status(400).send('Le paramètre "url" est manquant.');
    }

    console.log(`[Proxy Vercel] Requête reçue pour le flux : ${originalStreamUrl}`);

    // Détecter si l'URL est un segment .ts (ou si elle ne se termine PAS par .m3u8)
    // C'est une heuristique, à adapter si besoin.
    const isTsSegment = originalStreamUrl.includes('.ts') || (!originalStreamUrl.includes('.m3u8') && !originalStreamUrl.includes('.mpd'));

    if (isTsSegment) {
        console.log('[Proxy Vercel] Détecté comme un segment direct. Génération d\'un manifeste HLS.');

        // Générer un manifeste HLS simple qui pointe vers l'URL du segment
        // L'URL du segment doit être celle passée au proxy, donc le proxy va le re-proxifier
        const manifest = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:10.0,
${originalStreamUrl}
#EXT-X-ENDLIST`;

        res.setHeader('Content-Type', 'application/x-mpegURL'); // Type de contenu pour les manifestes HLS
        res.status(200).send(manifest);
        console.log('[Proxy Vercel] Manifeste HLS simple généré et envoyé.');
        return;
    }

    // Si ce n'est pas un .ts direct, procéder comme avant pour proxifier le flux
    try {
        const response = await axios({
            method: 'GET',
            url: originalStreamUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
                'Referer': originalStreamUrl,
                'Accept': '*/*'
            }
        });

        for (const header in response.headers) {
            if (header !== 'access-control-allow-origin') {
                res.setHeader(header, response.headers[header]);
            }
        }

        res.status(response.status);
        response.data.pipe(res);
        console.log(`[Proxy Vercel] Flux proxifié avec succès pour : ${originalStreamUrl}`);

    } catch (error) {
        console.error(`[Proxy Vercel] Erreur lors de la récupération du flux ${originalStreamUrl}:`, error.message);
        if (error.response) {
            console.error(`[Proxy Vercel] Statut de réponse source: ${error.response.status}`);
            console.error(`[Proxy Vercel] Données d'erreur source:`, error.response.data ? error.response.data.toString() : 'Aucune donnée');
            res.status(error.response.status).send(`Erreur du flux source: ${error.response.status}`);
        } else if (error.request) {
            console.error(`[Proxy Vercel] Aucune réponse reçue du flux source.`);
            res.status(504).send('Délai d\'attente de la passerelle (Gateway Timeout) lors de la récupération du flux.');
        } else {
            console.error(`[Proxy Vercel] Erreur inattendue:`, error.message);
            res.status(500).send('Erreur interne du proxy.');
        }
    }
});

// Route pour la racine de l'application Vercel (utile pour le débogage)
app.get('/', (req, res) => {
    res.status(200).send('Proxy TeslaTV est opérationnel. Utilisez /api?url= pour proxifier un flux.');
});

module.exports = app;