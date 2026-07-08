# Fenua Check

Vérifie que le prix facturé sur ton ticket de caisse correspond au prix affiché
en rayon (arrêté n°170 CM, Polynésie française). Nom du dépôt/Worker technique :
`ticket-temoin` (inchangé pour ne pas casser le déploiement existant), nom de
marque affiché : Fenua Check.

## Structure

```
index.html       page principale
css/style.css     styles (palette navy/sable/corail/turquoise)
js/app.js          logique de l'interface
js/image-compress.js  compression des photos avant envoi
js/ticket-api.js      appels vers /api/scan et /api/match
js/ticket-history.js  historique + articles fréquents (localStorage)
worker.js          script serveur (routes /api/scan, /api/match, sert le reste en fichiers statiques)
wrangler.jsonc      configuration Cloudflare Workers
.assetsignore       fichiers à ne pas servir comme fichiers statiques
```

## Déployer sur Cloudflare (Workers, modèle unifié 2026)

1. Pousse ce dossier sur un dépôt GitHub.
2. Sur https://dash.cloudflare.com → **Compute (Workers)** → **Create application**
   → connecte le dépôt GitHub `ticket-temoin`.
3. Laisse les commandes de build/déploiement par défaut (`npx wrangler deploy`
   est correct, `wrangler.jsonc` est déjà présent donc pas de configuration
   automatique à valider).
4. Une fois le Worker créé, va dans **Settings → Variables and Secrets** et
   ajoute :
   - `QWEN_API_KEY` = ta clé Qwen (type **Secret**)
   - `QWEN_BASE_URL` = `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
     (type **Text**, ou l'endpoint Chine continentale si ta clé y a été créée)
5. Relance un déploiement (`Create deployment` si besoin) pour que les
   variables prennent effet.

Ton site est en ligne à `https://<nom-du-worker>.<ton-compte>.workers.dev`, ou
attache un domaine personnalisé dans **Custom domains**.

### Tester en local avant de déployer

```bash
npx wrangler dev
```

## Ajouter de la publicité plus tard

Deux emplacements neutres sont déjà prévus dans `index.html`, cachés par
défaut (`hidden`) :

- `#ad-slot-header` (juste sous l'intro, pleine largeur, format bannière)
- `#ad-slot-content` (en bas, avant le pied de page, format natif/display)

Pour activer un réseau publicitaire (Google AdSense, etc.) : colle son script
d'intégration à l'intérieur de la div correspondante dans `index.html`, puis
retire l'attribut `hidden`. Le CSS (`.ad-slot` dans `style.css`) donne un
cadre neutre par défaut ; adapte-le au format exact fourni par le réseau
choisi.

## Notes

- Aucune clé API n'est jamais exposée au navigateur : `js/ticket-api.js`
  n'appelle que `/api/scan` et `/api/match`, qui tournent côté serveur
  (`worker.js`).
- L'historique et les articles fréquents restent uniquement sur l'appareil de
  l'utilisateur (`localStorage`), rien n'est envoyé à un serveur pour ça.
- Les photos sont compressées côté navigateur avant l'envoi (1600px max,
  JPEG qualité 82%) pour rester rapide et léger.


## Ajouter de la publicité plus tard

Deux emplacements neutres sont déjà prévus dans `index.html`, cachés par
défaut (`hidden`) :

- `#ad-slot-header` (juste sous l'intro, pleine largeur, format bannière)
- `#ad-slot-content` (en bas, avant le pied de page, format natif/display)

Pour activer un réseau publicitaire (Google AdSense, etc.) : colle son script
d'intégration à l'intérieur de la div correspondante dans `index.html`, puis
retire l'attribut `hidden`. Le CSS (`.ad-slot` dans `style.css`) donne un
cadre neutre par défaut ; adapte-le au format exact fourni par le réseau
choisi.

## Notes

- Aucune clé API n'est jamais exposée au navigateur : `js/ticket-api.js`
  n'appelle que `/api/scan` et `/api/match`, qui tournent côté serveur.
- L'historique et les articles fréquents restent uniquement sur l'appareil de
  l'utilisateur (`localStorage`), rien n'est envoyé à un serveur pour ça.
- Les photos sont compressées côté navigateur avant l'envoi (1600px max,
  JPEG qualité 82%) pour rester rapide et léger.
