// api/index.js
    // Ce script est le cœur de votre proxy Vercel.

    const express = require('express');
    const request = require('request');
    const cors = require('cors'); // Pour gérer les en-têtes CORS

    const app = express();

    // Applique le middleware CORS à TOUTES les requêtes.
    // C'est ce qui devrait ajouter l'en-tête 'Access-Control-Allow-Origin'.
    app.use(cors());

    // Définit le point d'accès pour votre fonction serverless.
    // Puisque ce fichier est dans le dossier 'api/', Vercel le rendra accessible via '/api'.
    // Donc, à l'intérieur de ce fichier, le chemin racine '/' correspond à '/api'.
    app.get('/', (req, res) => {
        const originalStreamUrl = req.query.url;

        if (!originalStreamUrl) {
            return res.status(400).send('Le paramètre "url" est manquant.');
        }

        console.log(`[Proxy Vercel] Requête reçue pour le flux : ${originalStreamUrl}`);

        // Fait la requête au flux original et transmet la réponse.
        request({ url: originalStreamUrl, encoding: null })
            .on('error', (err) => {
                console.error('[Proxy Vercel] Erreur lors de la récupération du flux :', err);
                res.status(500).send('Erreur interne du proxy lors de la récupération du flux.');
            })
            .pipe(res); // Transmet directement le flux
    });

    // C'est ESSENTIEL pour que Vercel puisse exécuter votre application Express en tant que fonction serverless.
    module.exports = app;
    