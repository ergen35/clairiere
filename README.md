# Clairière

Logiciel de bureau pour **Linux, Windows et macOS** : analyse les disques à toute vitesse, montre ce qui prend de la place sur une carte des dossiers, et libère de l'espace (suppression protégée, nettoyage des caches en un clic).

Disponible en anglais (par défaut), français, espagnol, allemand, chinois, coréen et russe. La langue est demandée au tout premier démarrage (ou si le réglage manque) et se change à tout moment depuis la barre latérale.

## Auteur

Développé par **Serge Eric Hotegni** ([github.com/ergen35](https://github.com/ergen35)).
Projet : [github.com/ergen35/clairiere](https://github.com/ergen35/clairiere).

## Construire

Il faut Node.js et Rust, plus `dpkg-deb` pour le paquet Linux.

```sh
npm install
npm run build        # compile l'interface et le moteur pour le système en cours
npm run package      # Linux : paquet .deb dans release/
npm run package:win  # Windows : installateur .exe dans release/ (à lancer sur Windows)
npm run package:mac  # macOS : image .dmg dans release/ (à lancer sur un Mac)
./clairiere          # Linux et macOS : lance l'application depuis le projet
```

Sans machine Windows ni Mac, GitHub s'en charge : à chaque envoi, l'intégration continue fabrique le `.deb`, l'installateur Windows et les deux `.dmg` (Mac Apple Silicon et Mac Intel), à télécharger depuis l'onglet *Actions*.

### Installateurs non signés

Les installateurs Windows et macOS ne sont pas encore signés avec un certificat :

- **Windows** : SmartScreen affiche « Windows a protégé votre ordinateur » → *Informations complémentaires* → *Exécuter quand même*.
- **macOS** : au premier lancement, ouvrez l'app par clic droit → *Ouvrir*, ou *Réglages Système → Confidentialité et sécurité → Ouvrir quand même*. Pour tout compter, autorisez Clairière dans *Accès complet au disque* (l'app propose le lien quand des dossiers lui sont fermés).

## Vérifier

- `npm run test:e2e` pilote la vraie application sur un dossier personnel factice créé dans `/tmp` : les vrais fichiers et les vraies commandes système ne sont jamais touchés.
- `node scripts/safety-check.mjs` vérifie les règles de protection de Windows, macOS et Linux depuis n'importe quel système (aucun fichier n'est touché).
- `scripts/look.mjs` ouvre l'application sur le vrai ordinateur en lecture seule. Ses captures, dans `shots/`, montrent de vrais noms de dossiers et restent hors du dépôt.

## Organisation

- `engine/` : moteur d'analyse et de suppression en Rust (Linux, Windows, macOS).
- `electron/` : côté bureau, dont les règles de protection de chaque système (`safety.ts`), les disques (`disks.ts`) et le catalogue des caches (`targets.ts`).
- `src/` : interface React.
- `shared/` : ce que l'interface et le côté bureau ont en commun, dont les traductions (`shared/locales/`).

Pour ajouter ou corriger une langue : `shared/locales/en.ts` est la référence, chaque autre fichier doit donner les mêmes phrases (la compilation échoue sinon).

Voir [CHANGELOG.md](CHANGELOG.md) pour l'historique des versions.
