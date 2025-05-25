    // api/index.js
    // Ce script est le cœur de votre proxy Vercel.

    const express = require('express');
    const request = require('request');
    const cors = require('cors');

    const app = express();
    app.use(cors()); // C'est crucial pour le CORS

    // La fonction serverless est mappée à '/api' par Vercel, donc son chemin racine interne est '/'
    app.get('/', (req, res) => {
        const originalStreamUrl = req.query.url;

        if (!originalStreamUrl) {
            return res.status(400).send('Le paramètre "url" est manquant.');
        }

        console.log(`[Proxy Vercel] Requête reçue pour le flux : ${originalStreamUrl}`);

        // Utilisation de 'request' pour proxifier le flux
        // Ajout d'en-têtes pour éviter certains problèmes de streaming
        request({
            url: originalStreamUrl,
            encoding: null, // Très important pour les flux binaires
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
                'Referer': originalStreamUrl // Peut être utile pour certains flux
            }
        })
        .on('error', (err) => {
            console.error('[Proxy Vercel] Erreur lors de la récupération du flux :', err);
            let errorMessage = 'Erreur interne du proxy lors de la récupération du flux.';
            if (err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') {
                errorMessage = `Erreur de connexion au flux source (${err.code}).`;
            }
            res.status(500).send(errorMessage);
        })
        .pipe(res); // Transmet directement le flux au client
    });

    // Essentiel pour que Vercel détecte et exécute ce fichier comme une fonction serverless
    module.exports = app;