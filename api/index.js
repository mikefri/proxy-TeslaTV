// api/index.js
// Ce script est le cœur de votre proxy Vercel, utilisant Axios pour plus de robustesse.

const express = require('express');
const axios = require('axios'); // Nouvelle bibliothèque pour les requêtes HTTP/HTTPS
const cors = require('cors');

const app = express();
app.use(cors());

// MODIFICATION ICI : La route est maintenant '/api' pour correspondre au chemin d'accès Vercel
app.get('/api', async (req, res) => {
    const originalStreamUrl = req.query.url;

    if (!originalStreamUrl) {
        console.log('[Proxy Vercel] Erreur: Le paramètre "url" est manquant.');
        return res.status(400).send('Le paramètre "url" est manquant.');
    }

    console.log(`[Proxy Vercel] Requête reçue pour le flux : ${originalStreamUrl}`);

    try {
        // Faire la requête au flux original en utilisant Axios
        const response = await axios({
            method: 'GET',
            url: originalStreamUrl,
            responseType: 'stream', // Important pour gérer les flux binaires
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
                'Referer': originalStreamUrl, // Peut être utile pour certains serveurs
                'Accept': '*/*' // Accepter tous les types de contenu
            }
        });

        // Transférer les en-têtes de la réponse du flux original au client
        for (const header in response.headers) {
            if (header !== 'access-control-allow-origin') {
                res.setHeader(header, response.headers[header]);
            }
        }

        // Transférer le code de statut HTTP
        res.status(response.status);

        // Transmettre le flux de données directement au client
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

// Pour la racine de l'application Vercel (par exemple, si on accède à https://proxy-tesla-tv.vercel.app/)
// C'est souvent utile pour avoir un message d'accueil ou de débogage.
app.get('/', (req, res) => {
    res.status(200).send('Proxy TeslaTV est opérationnel. Utilisez /api?url= pour proxifier un flux.');
});


module.exports = app;