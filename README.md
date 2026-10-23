# BacRush — Petit Bac multijoueur, 15 manches, arbitrage par IA

BacRush est un jeu de Petit Bac en ligne. Le serveur est la seule source de vérité : il tire
les lettres, tient le chronomètre, enregistre les réponses, décide de la
clôture, fait vérifier chaque mot par l'IA et applique le barème. Le navigateur
se contente d'afficher et d'envoyer des intentions.

## Démarrer

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Le démarrage affiche deux adresses :

```
Sur cet ordinateur : http://localhost:3000
Depuis un téléphone (en0) : http://192.168.1.x:3000
```

Un joueur crée la partie et partage le code à 4 caractères ; les autres le
saisissent depuis leur propre appareil (ordinateur, tablette ou téléphone sur
le même réseau Wi-Fi).

Sans `ANTHROPIC_API_KEY`, le jeu fonctionne en **mode secours** : l'interface
l'indique clairement et la validation s'appuie sur des lexiques et des règles
locales, bien plus limitées que l'IA.

## Règles appliquées

| Règle | Mise en œuvre |
|---|---|
| 8 rubriques fixes | `src/shared/categories.js` |
| 15 manches, 15 lettres distinctes | tirage unique par partie (`src/game/letters.js`), 20 lettres éligibles (K, Q, W, X, Y, Z écartées) |
| 240 s par manche | horloge serveur (`src/game/room.js`), le navigateur n'affiche qu'un décompte dérivé |
| Bouton FIN | invisible tant que les 8 rubriques ne sont pas remplies, revérifié côté serveur |
| Clôture globale | un seul clic accepté, la manche se termine pour tout le monde |
| Fin automatique à 00:00 | balayage serveur toutes les 250 ms, sans dépendre d'un navigateur ouvert |
| Barème 2 / 1 / 0 | `src/game/scoring.js`, appliqué après validation, jamais par l'IA |

## Comment l'IA valide (le cœur du jeu)

1. **Constitution du lot** — les réponses vides ne partent pas à l'IA (elles
   valent 0). Chaque réponse reçoit un identifiant opaque (`r1`, `r2`, …) :
   l'identité des joueurs n'est jamais transmise au modèle, ce qui évite tout
   biais entre participants.
2. **Premier examen** (`src/ai/anthropic-validator.js`) — un appel au modèle
   `claude-opus-5` avec un outil à schéma strict : pour chaque réponse, le mot
   réellement voulu, sa première lettre, une clé canonique d'entité, un statut
   (`valide` / `invalide` / `a_verifier`), un motif, un niveau de confiance.
3. **Vérification documentaire** — seules les réponses restées incertaines
   repartent dans un second appel, cette fois avec l'outil de recherche web
   exécuté côté Anthropic. Une recherche infructueuse ne refuse pas la réponse :
   elle reste « à vérifier ».
4. **Contrôle serveur** (`src/ai/schema.js`) — les identifiants inventés sont
   ignorés, les champs bornés, les statuts inconnus ramenés à « à vérifier », et
   toute réponse oubliée par le modèle reçoit un verdict par défaut. Les
   verdicts sont ensuite réassociés à leur couple (joueur, rubrique).
5. **Règle de la lettre, revérifiée** (`src/game/scoring.js`) — le serveur
   contrôle lui-même la première lettre du mot reconnu *et* du texte saisi.
   Même si l'IA validait « Paris » pour la lettre M, la réponse vaut 0.
6. **Regroupement** — uniquement entre réponses retenues, dans la même rubrique
   et la même manche, sur la clé canonique de l'IA ou l'égalité exacte. Aucune
   fusion « par ressemblance » : *Marie* et *Maria* restent deux réponses.
7. **Barème** — groupe d'un seul joueur : 2 points ; groupe partagé : 1 point
   chacun ; vide, invalide ou mauvaise lettre : 0. Les points d'une manche ne
   peuvent être attribués qu'une seule fois.

### Si l'IA est indisponible

Aucune validation globale n'est appliquée. Le validateur de secours
(`src/ai/fallback-validator.js`) accepte ce qu'il reconnaît vraiment, refuse ce
qui relève manifestement d'une autre rubrique (« Mouton » en Métier) ou de la
mauvaise lettre, et marque le reste « à vérifier ». Ces cas incertains sont
comptés mais signalés dans les résultats (`BACRUSH_UNCERTAIN_POLICY=strict`
pour les refuser). Une échéance globale garantit qu'une manche ne reste jamais
bloquée en attente du modèle.

## Architecture

```
src/
  server.js              HTTP + SSE + fichiers statiques, aucune clé exposée
  shared/categories.js   les 8 rubriques et leurs règles
  shared/normalize.js    normalisation, distance d'édition, première lettre
  game/letters.js        tirage des 15 lettres distinctes
  game/room.js           machine d'état d'une partie (chrono, clôture, scores)
  game/hub.js            salles, balayage temporel, déclenchement de validation
  game/scoring.js        regroupement + barème fixe
  ai/prompt.js           consignes d'arbitrage et mise en forme du lot
  ai/schema.js           schéma de sortie + contrôle serveur des verdicts
  ai/anthropic-validator.js  appels réels (SDK officiel), 2 passes
  ai/fallback-validator.js   validation hors ligne
  ai/validator.js        orchestration, échéances, bascule de secours
public/                  interface (HTML/CSS/JS, sans build)
tests/                   66 tests
```

Transport : SSE (`GET /api/stream`) pour les états poussés par le serveur,
`POST /api/rooms/...` pour les actions. Pas de dépendance de transport ; la
seule dépendance du projet est le SDK Anthropic officiel.

## Sur téléphone

L'interface est pensée pour être jouée au pouce :

- une seule colonne, champs hauts et espacés, texte à 16 px (pas de zoom iOS) ;
- barre collante en haut : manche, salle, **lettre** et chronomètre restent
  visibles pendant le défilement des 8 rubriques ;
- bouton FIN pleine largeur ancré en bas, au-dessus d'un dégradé, avec marge de
  sécurité pour les écrans à encoche ;
- clavier adapté (`enterkeyhint`, majuscule automatique, correction désactivée) ;
  la touche Entrée passe à la rubrique suivante, puis déclenche FIN ;
- aucun défilement horizontal, y compris sur le tableau du classement final
  (il défile dans son propre conteneur).

## Tests

```bash
npm test          # 63 tests, sans réseau ni clé d'API
npm run test:ai   # ajoute les tests de l'IA réelle (nécessite ANTHROPIC_API_KEY)
```

`tests/anthropic-request.test.js` fait dialoguer le vrai SDK avec une API
factice pour vérifier la forme exacte des requêtes (outil strict, choix d'outil
forcé, outil de recherche, reprise après `pause_turn`) sans consommer de jetons.

## Limites connues

- L'état des parties vit en mémoire : un redémarrage du serveur efface les
  parties en cours.
- Le mode secours est volontairement modeste ; il ne remplace pas l'IA.
- Les salons sont ouverts à qui connaît le code (jeu entre amis, réseau de
  confiance).
