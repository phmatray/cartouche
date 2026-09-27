// Traduction française de legal.ts (la version anglaise fait foi). Mêmes sections, mêmes adresses.
import type { LegalSection } from './legal';

export const LEGAL_FR: LegalSection[] = [
  {
    title: 'Avertissement',
    body:
      'Cartouche est un émulateur indépendant et open source pour les jeux Game Boy et Game Boy Color. ' +
      'Il n’est ni affilié à Nintendo, ni parrainé ni approuvé par Nintendo. Game Boy, Game Boy Color ' +
      'et Nintendo sont des marques de Nintendo. Les titres de jeux sont des marques de leurs propriétaires ' +
      'respectifs et ne sont utilisés que pour identifier les jeux.\n\n' +
      'Cartouche est fourni « en l’état », sans garantie d’aucune sorte, sous licence MIT. Il appartient à ' +
      'chacun de s’assurer d’avoir le droit d’utiliser les fichiers qu’il charge.',
  },
  {
    title: 'Ce que contient Cartouche',
    body:
      'Un émulateur qui ne contient aucun code Nintendo ni aucune copie du logo Nintendo. Il inclut les boot ROM ' +
      'open source de SameBoy, © 2015-2026 Lior Halphon, licence MIT (https://github.com/LIJI32/SameBoy) : du code ' +
      'original, pas celui de Nintendo. Par défaut, les jeux démarrent directement dans l’état documenté qui suit ' +
      'le démarrage ; les couleurs Game Boy Color d’un jeu Game Boy d’origine, si vous les choisissez, sont calculées ' +
      'par cette boot ROM sans être affichée. L’animation de démarrage est désactivée par défaut. Une fois activée ' +
      '(Réglages > Émulation), elle affiche le logo lu dans la cartouche du jeu, comme la console.\n\n' +
      'Trois jeux homebrew gratuits, redistribués sans modification à partir des versions officielles de leurs auteurs :\n\n' +
      'Tobu Tobu Girl et Tobu Tobu Girl Deluxe, © 2017 Tangram Games (sources : ' +
      'https://github.com/SimonLarsen/tobutobugirl et https://github.com/SimonLarsen/tobutobugirl-dx). ' +
      'Code sous licence MIT ; graphismes, textes, sons et musique sous CC BY 4.0 ' +
      '(https://creativecommons.org/licenses/by/4.0/). Les fichiers publiés tobu.gb et tobudx.gb sont ' +
      'renommés tobutobugirl.gb et tobutobugirldx.gb. Leurs jaquettes sont les illustrations officielles de Tangram ' +
      'Games tirées de leurs pages itch.io (https://tangramgames.itch.io/tobutobugirl et ' +
      'https://tangramgames.itch.io/tobu-tobu-girl-deluxe), sous CC BY 4.0, recadrées au format carré et redimensionnées.\n\n' +
      'µCity 1.3, © 2017-2018 Antonio Niño Díaz, sous licence GNU GPL version 3 ou ultérieure (graphismes et ' +
      'musique sous CC BY-SA 4.0, https://creativecommons.org/licenses/by-sa/4.0/ ; son moteur GBT Player sous BSD 2-Clause). Le texte complet de la GPL est lié ci-dessous ; le ' +
      'code source correspondant complet est l’étiquette v1.3 de l’auteur : https://github.com/AntonioND/ucity/tree/v1.3 ' +
      '(aussi https://codeberg.org/SkyLyrac/ucity/src/tag/v1.3, et joint à chaque version de Cartouche). ' +
      'µCity est un programme distinct que l’émulateur charge comme des données (simple agrégation) : sa licence ne ' +
      's’applique pas à Cartouche.\n\n' +
      'Trois cartouches de test, redistribuées sans modification : dmg-acid2 (v1.0) et cgb-acid2 (v1.1) de Matt ' +
      'Currie, licence MIT (https://github.com/mattcurrie/dmg-acid2, https://github.com/mattcurrie/cgb-acid2), ' +
      'et cpu_instrs de Blargg, par Shay Green, issu de https://github.com/retrio/gb-test-roms. Son auteur ' +
      'n’indique aucune licence ; il est inclus parce que la communauté de l’émulation le redistribue largement pour ' +
      'les tests, et il sera retiré immédiatement à la demande de l’auteur.\n\n' +
      'Une base de données de dumps Game Boy et Game Boy Color connus (empreintes de fichiers, titres et noms ' +
      'No-Intro), utilisée uniquement pour identifier les fichiers ajoutés. La bibliothèque liste des homebrews gratuits, des ' +
      'cartouches de test librement disponibles et les ROM personnelles, jamais de jeux commerciaux. Aucune image de jeu commercial.',
  },
  {
    title: 'Aucune ROM fournie',
    body:
      'Cartouche n’inclut pas, n’héberge pas, ne propose aucun lien vers des ROM de jeux commerciaux ni vers des fichiers ' +
      'BIOS et n’aide pas à en trouver, et ne liste aucun jeu commercial. Sa base de dumps connus ne fait que reconnaître un ' +
      'fichier chargé par l’utilisateur lui-même.\n\n' +
      'Ne jouez qu’aux jeux que vous possédez, avec des copies de sauvegarde que vous avez faites vous-même à partir de vos propres cartouches. La législation ' +
      'sur les copies de sauvegarde varie d’un pays à l’autre ; vérifiez celle qui s’applique à vous.',
  },
  {
    title: 'Jaquettes',
    body:
      'Les deux jeux Tobu Tobu Girl sont fournis avec leurs propres jaquettes (sous licence libre, voir ci-dessus) : ce sont ' +
      'des fichiers de cette app, affichés sans demande et sans contacter aucun autre site. Toutes les autres ' +
      'jaquettes sont désactivées par défaut et ne sont jamais hébergées ni redistribuées par Cartouche. Ces images appartiennent ' +
      'aux éditeurs des jeux et aux autres titulaires de droits. Au premier lancement, une boîte de dialogue demande « Afficher les jaquettes ? ». ' +
      'Seulement si « Télécharger les jaquettes » est choisi (ou si les jaquettes sont activées plus tard dans Réglages > Stockage, avec accord), ' +
      'le navigateur télécharge la jaquette de chaque ROM reconnue ajoutée, directement depuis le ' +
      'projet libretro-thumbnails sur GitHub (https://github.com/libretro-thumbnails, servi depuis ' +
      'raw.githubusercontent.com), et la conserve dans le stockage de ce navigateur (Cache Storage). La réponse ' +
      'et sa date sont enregistrées dans les réglages, et la restauration d’une copie de sauvegarde ne les modifie jamais. La question ' +
      'n’est reposée que si les jaquettes sont activées après un refus, ou après « Tout effacer ». Avec ' +
      '« Continuer sans » (ou Esc), l’app ne fait aucune requête à libretro-thumbnails. ' +
      'Réglages > Stockage indique l’espace utilisé par les jaquettes, les supprime (« Supprimer les jaquettes téléchargées », ' +
      'qui désactive aussi les jaquettes) et les télécharge à nouveau pour la bibliothèque.',
  },
  {
    title: 'Métadonnées des jeux',
    body:
      'Les titres, développeurs, dates de sortie et genres proviennent de GameDataBase © 2024 par PigSaint ' +
      '(https://github.com/PigSaint/GameDataBase), sous licence CC BY 4.0 ' +
      '(https://creativecommons.org/licenses/by/4.0/). Les noms No-Intro proviennent de libretro-database ' +
      '(https://github.com/libretro/libretro-database), sous licence CC BY-SA 4.0 ' +
      '(https://creativecommons.org/licenses/by-sa/4.0/). Modifications : Cartouche conserve une partie des ' +
      'colonnes, relie les deux par empreinte de fichier et publie le fichier combiné (gamedb.json) sous ' +
      'CC BY-SA 4.0. Aucun des deux projets ne cautionne Cartouche.',
  },
  {
    title: 'Confidentialité',
    body:
      'Pas de compte, pas de serveur, pas de statistiques, pas de publicité, pas de cookies.\n\n' +
      'Les ROM, sauvegardes, sauvegardes instantanées, réglages, favoris et temps de jeu sont stockés uniquement dans ce ' +
      'navigateur (IndexedDB et localStorage) et ne quittent jamais l’appareil. Effacer les données de ce site dans ' +
      'les réglages du navigateur supprime tout.\n\n' +
      'Seul GitHub reçoit des requêtes. GitHub Pages sert l’app et ses polices. Les jaquettes sont désactivées par ' +
      'défaut et nécessitent un accord (boîte de dialogue du premier lancement ou Réglages > Stockage) ; seulement alors le ' +
      'navigateur charge aussi les jaquettes des ROM reconnues ajoutées depuis raw.githubusercontent.com. Comme tout ' +
      'serveur web, GitHub reçoit ' +
      'l’adresse IP et les informations du navigateur ; voir la déclaration générale de confidentialité de GitHub ' +
      '(https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).\n\n' +
      'Les jaquettes téléchargées sont conservées dans ce navigateur (Cache Storage) et ne sont jamais envoyées nulle part. Elles peuvent être supprimées à tout moment avec ' +
      '« Supprimer les jaquettes téléchargées » dans Réglages > Stockage, ou en effaçant les données du site.',
  },
  {
    title: 'Demandes de retrait',
    body:
      'Si quelque chose dans Cartouche semble porter atteinte à vos droits, ouvrez un ticket « Takedown request » ' +
      'sur https://github.com/phmatray/cartouche/issues/new/choose (les tickets sont publics). Pour une ' +
      'demande non publique, utilisez la procédure DMCA de GitHub ' +
      '(https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy) ; le ' +
      'projet n’a pas d’adresse e-mail privée.\n\n' +
      'Le mainteneur s’efforce de répondre sous 72 heures. Un contenu plausiblement contrefaisant est ' +
      'd’abord désactivé, puis examiné.',
  },
  {
    title: 'Open source',
    body:
      'Code source : https://github.com/phmatray/cartouche (licence MIT). Les textes de licence ci-dessous ' +
      'sont publiés avec l’app, et THIRD_PARTY_NOTICES.md dans le dépôt contient les mêmes mentions.',
    links: [
      { file: 'LICENSE.txt', label: 'Licence de Cartouche (MIT)' },
      { file: 'THIRD_PARTY_NOTICES.txt', label: 'Mentions de tiers (jeux et cartouches de test inclus, GameDataBase, polices, jaquettes)' },
      { file: 'licenses/GPL-3.0-ucity.txt', label: 'GNU GPL version 3 (µCity)' },
      { file: 'THIRD_PARTY_LICENSES.txt', label: 'Licences complètes des paquets npm, crates Rust et polices inclus' },
    ],
  },
];
