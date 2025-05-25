// proxy.js
// Ce script crée un serveur proxy simple en Node.js.
// Il sera déployé sur Vercel et gérera les flux HTTP pour votre site HTTPS.

const express = require('express');
const request = require('request'); // Pour faire la requête HTTP vers le flux original
const cors = require('cors');     // Pour autoriser votre site web à communiquer avec ce proxy

const app = express();
const PORT = process.env.PORT || 3000; // Vercel définira automatiquement son propre port, pas besoin de s'en soucier pour le déploiement. Pour les tests locaux, ce sera le port 3000.

// Active CORS pour toutes les requêtes.
// C'est ESSENTIEL pour que votre site (mikefri.github.io) puisse faire des requêtes à ce proxy.
app.use(cors());

// Définit le point d'accès (endpoint) de votre proxy.
// Lorsque votre site fera une requête à https://votre-proxy-vercel.app/proxy-stream?url=...", ce code s'exécutera.
app.get('/proxy-stream', (req, res) => {
    // Récupère l'URL du flux vidéo original (par exemple, http://mu3241218.oknirvana.club:8880/...)
    // Cette URL est passée par votre site dans le paramètre 'url' de la requête au proxy.
    const originalStreamUrl = req.query.url;

    // Si l'URL du flux n'est pas fournie, renvoie une erreur.
    if (!originalStreamUrl) {
        return res.status(400).send('Le paramètre "url" du flux vidéo est manquant.');
    }

    console.log(`[Proxy] Requête reçue pour le flux : ${originalStreamUrl}`);

    // Utilise la bibliothèque 'request' pour aller chercher le flux original.
    // `encoding: null` est crucial pour gérer les données binaires du flux vidéo correctement.
    request({ url: originalStreamUrl, encoding: null })
        .on('error', (err) => {
            // Gère les erreurs si le proxy ne peut pas atteindre le flux original (par exemple, le flux est hors ligne)
            console.error('[Proxy] Erreur lors de la récupération du flux :', err);
            res.status(500).send('Erreur interne du proxy lors de la récupération du flux.');
        })
        // Le .pipe(res) est la magie : il transmet directement le flux de données
        // du serveur original à la réponse du proxy, sans avoir à tout charger en mémoire.
        .pipe(res);
});

// Le proxy démarre et écoute les requêtes.
app.listen(PORT, () => {
    console.log(`[Proxy] Serveur démarré sur le port ${PORT}`);
});