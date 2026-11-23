# Personnalisation Omnitech (fork FUXA-OPCUA-PostgreSQL)

Cette version conserve **toutes les fonctionnalités FUXA d'origine**, y compris l'onglet **OPCUA->PostgreSQL** de la page `/device`.
Seule l'interface graphique de `/device` a été refondue : thème sombre industriel, layout « rail de connexions + panneau détail », cartes et dialogues restylés.

## Fichiers modifiés

| Fichier | Rôle |
|---|---|
| `client/src/omnitech-device.css` | Thème sombre industriel, scoppé à `app-device` et `body.omnitech-device` |
| `client/angular.json` | Ajout de `src/omnitech-device.css` aux styles globaux |
| `client/src/app/device/device.component.html` | Layout rail + panneau, carte d'accueil, badge Omnitech, 3 onglets conservés |
| `client/src/app/device/device.component.scss` | Styles du header, badge et conteneur `device-main` |
| `client/src/app/device/device.component.ts` | Classe `omnitech-device` sur `<body>` pendant la page `/device` |
| `client/src/environments/environment.ts` | `apiPort: null` : l'API utilise le port courant (dépôt portable) |
| `client/src/assets/i18n/*.json` (13 fichiers) | Textes device préfixés « Omnitech » |

## Reconstruction

```powershell
cd "...\FUXA-OPCUA-PostgreSQL-main\client"
npm ci
npm run build
```

Le serveur (`server/main.js`) sert `client/dist` : rechargez la page après reconstruction.

## Démarrage

```powershell
cd "...\FUXA-OPCUA-PostgreSQL-main\server"
npm install
node main.js                 # port 1881 par défaut
# ou : $env:PORT='1883'; node main.js
```

Le serveur de ce fork nécessite le paquet `xlsx` utilisé par l'outil OPCUA->PostgreSQL.

## Périmètre

- Les autres pages FUXA ne sont pas modifiées.
- Les composants Angular d'origine (`app-connections-list`, `app-device-list`, `app-device-map`, iframe OPCUA->PostgreSQL et tous les dialogues) sont conservés : seul leur style et leur position changent.
