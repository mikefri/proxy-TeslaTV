// api/index.js
const express = require('express');
const request = require('request');
const cors = require('cors');

const app = express();
app.use(cors());

app.get('/', (req, res) => {
    const originalStreamUrl = req.query.url;

    if (!originalStreamUrl) {
        return res.status(400).send('Le paramètre "url" est manquant.');
    }

    console.log(`[Proxy Vercel] Requête reçue pour le flux : ${originalStreamUrl}`);

    request({ url: originalStreamUrl, encoding: null })
        .on('error', (err) => {
            console.error('[Proxy Vercel] Erreur lors de la récupération du flux :', err);
            res.status(500).send('Erreur interne du proxy lors de la récupération du flux.');
        })
        .pipe(res);
});

module.exports = app;