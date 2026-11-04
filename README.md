# Clairière

Logiciel de bureau pour Linux : analyse les disques à toute vitesse, montre ce qui prend de la place sur une carte des dossiers, et libère de l'espace (suppression protégée, nettoyage des caches en un clic).

## Auteur

Développé par **Serge Eric Hotegni** ([github.com/ergen35](https://github.com/ergen35)).
Projet : [github.com/ergen35/clairiere](https://github.com/ergen35/clairiere).

## Construire

Il faut Node.js, Rust et `dpkg-deb`.

```sh
npm install
npm run build      # compile l'interface et le moteur
npm run package    # fabrique le paquet .deb dans release/
./clairiere        # lance l'application depuis le projet
```

## Vérifier

`npm run test:e2e` pilote la vraie application sur un dossier personnel factice créé dans `/tmp` : les vrais fichiers et les vraies commandes système ne sont jamais touchés.

`scripts/look.mjs` ouvre l'application sur le vrai ordinateur en lecture seule. Ses captures, dans `shots/`, montrent de vrais noms de dossiers et restent hors du dépôt.

## Organisation

- `engine/` : moteur d'analyse et de suppression en Rust.
- `electron/` : côté bureau, dont les règles de protection (`safety.ts`) et le catalogue des caches (`targets.ts`).
- `src/` : interface React.
- `shared/` : ce que l'interface et le côté bureau ont en commun.

Voir [CHANGELOG.md](CHANGELOG.md) pour l'historique des versions.
