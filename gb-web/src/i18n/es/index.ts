import type { Messages } from '../core.ts';
import common from './common.ts';
import shell from './shell.ts';
import library from './library.ts';
import search from './search.ts';
import game from './game.ts';
import player from './player.ts';
import add from './add.ts';
import link from './link.ts';
import online from './online.ts';
import settings from './settings.ts';
import legal from './legal.ts';
import periph from './periph.ts';
import sync from './sync.ts';

const es: Messages = { common, shell, library, search, game, player, add, link, online, settings, legal, periph, sync };
export default es;
