// Traducción al español de legal.ts (prevalece la versión en inglés). Mismas secciones, mismas direcciones.
import type { LegalSection } from './legal';

export const LEGAL_ES: LegalSection[] = [
  {
    title: 'Descargo de responsabilidad',
    body:
      'Cartouche es un emulador independiente y de código abierto para juegos de Game Boy y Game Boy Color. ' +
      'No está afiliado, patrocinado ni respaldado por Nintendo. Game Boy, Game Boy Color ' +
      'y Nintendo son marcas de Nintendo. Los títulos de los juegos son marcas de sus respectivos ' +
      'propietarios y se usan solo para identificar los juegos.\n\n' +
      'Cartouche se ofrece «tal cual», sin garantía de ningún tipo, bajo la licencia MIT. Eres ' +
      'responsable de asegurarte de que tienes derecho a usar los archivos que cargas.',
  },
  {
    title: 'Qué contiene Cartouche',
    body:
      'Un emulador que no contiene código de Nintendo ni ninguna copia del logo de Nintendo. Incluye las boot ROM ' +
      'de código abierto de SameBoy, © 2015-2026 Lior Halphon, licencia MIT (https://github.com/LIJI32/SameBoy): ' +
      'código original, no el de Nintendo. Por defecto, los juegos arrancan directamente en el estado documentado ' +
      'posterior al arranque; los colores de Game Boy Color de un juego de Game Boy original, si los eliges, los ' +
      'calcula esa boot ROM sin mostrarse. La animación de inicio está desactivada por defecto. Si la activas ' +
      '(Ajustes > Emulación), muestra el logo leído del propio cartucho del juego, como la consola. Los marcos y colores de Super Game Boy ' +
      'se dibujan a partir de los datos que envía cada juego; no se incluye ningún software de Super Game Boy ni de SNES.\n\n' +
      'Tres juegos homebrew gratuitos, redistribuidos sin modificar a partir de las versiones oficiales de sus autores:\n\n' +
      'Tobu Tobu Girl y Tobu Tobu Girl Deluxe, © 2017 Tangram Games (código fuente: ' +
      'https://github.com/SimonLarsen/tobutobugirl y https://github.com/SimonLarsen/tobutobugirl-dx). ' +
      'Código bajo la licencia MIT; gráficos, textos, sonido y música bajo CC BY 4.0 ' +
      '(https://creativecommons.org/licenses/by/4.0/). Los archivos publicados tobu.gb y tobudx.gb se ' +
      'renombran tobutobugirl.gb y tobutobugirldx.gb. Sus carátulas son el arte oficial de Tangram ' +
      'Games de sus páginas de itch.io (https://tangramgames.itch.io/tobutobugirl y ' +
      'https://tangramgames.itch.io/tobu-tobu-girl-deluxe), CC BY 4.0, recortadas en cuadrado y redimensionadas.\n\n' +
      'µCity 1.3, © 2017-2018 Antonio Niño Díaz, bajo la GNU GPL versión 3 o posterior (gráficos y ' +
      'música CC BY-SA 4.0, https://creativecommons.org/licenses/by-sa/4.0/; su motor GBT Player BSD 2-Clause). El texto completo de la GPL está enlazado abajo; el ' +
      'código fuente correspondiente completo es la etiqueta v1.3 del autor: https://github.com/AntonioND/ucity/tree/v1.3 ' +
      '(también https://codeberg.org/SkyLyrac/ucity/src/tag/v1.3, y adjunto a cada versión de Cartouche). ' +
      'µCity es un programa independiente que el emulador carga como datos (mera agregación): su licencia no ' +
      'se aplica a Cartouche.\n\n' +
      'Tres cartuchos de prueba, redistribuidos sin modificar: dmg-acid2 (v1.0) y cgb-acid2 (v1.1) de Matt ' +
      'Currie, licencia MIT (https://github.com/mattcurrie/dmg-acid2, https://github.com/mattcurrie/cgb-acid2), ' +
      'y cpu_instrs de Blargg, de Shay Green, de https://github.com/retrio/gb-test-roms. Su autor ' +
      'no indica ninguna licencia; se incluye porque la comunidad de la emulación lo redistribuye ampliamente para ' +
      'pruebas, y se retirará de inmediato a petición del autor.\n\n' +
      'Cuatro juegos creados con GB Studio, alojados sin modificar porque las licencias de sus autores permiten ' +
      'redistribuir la ROM completa: Dawn Will Come (código MIT, gráficos y música CC BY 4.0), Poltersprite (juego ' +
      'CC BY-NC-SA 4.0, código GPL-3.0), Millennium Gun (código 0BSD, gráficos y sonido CC0 1.0, plugin MIT) y ' +
      'Dusky Dungeon (MIT, gráficos CC BY 4.0, fuentes CC BY 4.0 y CC BY 3.0). Cada uno se descarga solo cuando lo ' +
      'pides. Sus autores, fuentes y condiciones de licencia completas están en roms/gbstudio/LICENSES.txt, enlazado ' +
      'más abajo. Los demás juegos de la colección GB Studio no se alojan: enlazan a las páginas de sus autores.\n\n' +
      'Una base de datos de volcados conocidos de Game Boy y Game Boy Color (huellas de archivos, títulos y nombres ' +
      'No-Intro), usada solo para identificar los archivos que añades. La biblioteca muestra homebrew gratuito, ' +
      'cartuchos de prueba de libre disponibilidad y tus propias ROM, nunca juegos comerciales. Ninguna imagen de juegos comerciales.',
  },
  {
    title: 'No se proporcionan ROM',
    body:
      'Cartouche no incluye, aloja ni enlaza ROM de juegos comerciales ni archivos de BIOS, ni te ayuda a encontrarlos, ' +
      'y no muestra juegos comerciales. Su base de datos de volcados conocidos solo reconoce un ' +
      'archivo que cargas tú mismo.\n\n' +
      'Juega a los juegos que posees, usando copias de seguridad que hayas hecho tú mismo de tus propios cartuchos. Las leyes sobre copias de seguridad ' +
      'varían entre países; consulta las del tuyo.',
  },
  {
    title: 'Carátulas',
    body:
      'Los dos juegos Tobu Tobu Girl vienen con sus propias portadas (con licencia libre, ver arriba): son ' +
      'archivos de esta app, que se muestran sin preguntar y sin contactar con ningún otro sitio. Todas las demás ' +
      'portadas están desactivadas de forma predeterminada y Cartouche nunca las aloja ni las redistribuye. Esas imágenes pertenecen a ' +
      'las editoras de los juegos y a otros titulares de derechos. En el primer inicio, un cuadro de diálogo pregunta «¿Mostrar carátulas?». ' +
      'Solo si eliges «Descargar carátulas» (o activas más tarde las carátulas en Ajustes > Almacenamiento y lo aceptas) ' +
      'tu navegador descarga la portada de cada ROM reconocida que añadiste, directamente del ' +
      'proyecto libretro-thumbnails en GitHub (https://github.com/libretro-thumbnails, servido desde ' +
      'raw.githubusercontent.com), y la guarda en el almacenamiento de este navegador (Cache Storage). Tu respuesta ' +
      'y su fecha se guardan en tus ajustes, y restaurar una copia de seguridad nunca las cambia. Solo se ' +
      'vuelve a preguntar si activas las carátulas después de haber dicho que no, o después de «Borrar todo». Con ' +
      '«Continuar sin ellas» (o Escape), la app no hace ninguna petición a libretro-thumbnails. ' +
      'Ajustes > Almacenamiento muestra el espacio que ocupan las portadas, las elimina («Eliminar las carátulas descargadas», ' +
      'que también desactiva las carátulas) y las vuelve a descargar para tu biblioteca.',
  },
  {
    title: 'Metadatos de los juegos',
    body:
      'Los títulos, desarrolladores, fechas de lanzamiento y géneros provienen de GameDataBase © 2024 de PigSaint ' +
      '(https://github.com/PigSaint/GameDataBase), con licencia CC BY 4.0 ' +
      '(https://creativecommons.org/licenses/by/4.0/). Los nombres No-Intro provienen de libretro-database ' +
      '(https://github.com/libretro/libretro-database), con licencia CC BY-SA 4.0 ' +
      '(https://creativecommons.org/licenses/by-sa/4.0/). Modificado: Cartouche conserva un subconjunto de las ' +
      'columnas, une ambas por la huella del archivo y publica el archivo combinado (gamedb.json) bajo ' +
      'CC BY-SA 4.0. Ninguno de los dos proyectos respalda Cartouche.',
  },
  {
    title: 'Privacidad',
    body:
      'Sin cuenta, sin servidor, sin analíticas, sin publicidad, sin cookies.\n\n' +
      'Tus ROM, partidas guardadas, estados guardados, ajustes, favoritos y tiempo de juego se guardan solo en este ' +
      'navegador (IndexedDB y localStorage) y nunca salen de tu dispositivo, salvo si activas la sincronización entre dispositivos (ver más abajo). Borra los datos de este sitio en ' +
      'los ajustes de tu navegador para eliminarlo todo.\n\n' +
      'Solo GitHub recibe peticiones, salvo si conectas RetroAchievements, juegas en línea o activas la sincronización entre dispositivos (ver más abajo). GitHub Pages sirve la app y sus fuentes. Las carátulas están desactivadas de forma ' +
      'predeterminada y necesitan tu aceptación (cuadro de diálogo del primer inicio o Ajustes > Almacenamiento); solo entonces el ' +
      'navegador carga también las portadas de las ROM reconocidas que añadiste desde raw.githubusercontent.com. Como cualquier ' +
      'servidor web, GitHub recibe ' +
      'tu dirección IP y los datos de tu navegador; consulta la declaración general de privacidad de GitHub ' +
      '(https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).\n\n' +
      'Las carátulas descargadas se guardan en este navegador (Cache Storage) y nunca se envían a ninguna parte. Elimínalas cuando quieras con ' +
      '«Eliminar las carátulas descargadas» en Ajustes > Almacenamiento, o borrando los datos del sitio.\n\n' +
      'RetroAchievements está desactivado hasta que conectas tu cuenta en Ajustes > Logros con tu nombre de usuario y tu clave ' +
      'de la API web (nunca tu contraseña). Ambos se quedan en este navegador (localStorage). Mientras estás conectado, el navegador ' +
      'pide a retroachievements.org (https://retroachievements.org) la lista de juegos de las dos consolas y, para un juego que ' +
      'abres, sus logros y cuáles has conseguido; la clave y el usuario van en esas peticiones, como exige su API web. Una ROM se ' +
      'reconoce comparando su huella MD5 con esas listas en el navegador: nunca se envían ni la ROM ni su huella. ' +
      'RetroAchievements recibe tu dirección IP y los datos de tu navegador. «Desconectar» olvida la clave y detiene toda petición.\n\n' +
      'El juego en línea (Cable Link) y la sincronización entre dispositivos (Ajustes > Sincronizar) no hacen ninguna ' +
      'petición hasta que abres o te unes a una sala, o vinculas un dispositivo. Entonces tu navegador contacta cinco ' +
      'relés Nostr públicos que Cartouche no gestiona (relay02.lnfi.network, staging.yabu.me, top.testrelay.top, ' +
      'yabu.me y relay.mostro.network) para encontrar el otro navegador, y servidores STUN públicos de Google y ' +
      'Cloudflare para conocer su propia dirección de red. Los relés solo transmiten un saludo cifrado, pero ven las ' +
      'direcciones IP de ambos navegadores, y el otro jugador o dispositivo conoce la tuya: así funciona una conexión ' +
      'directa (WebRTC). Los datos de juego y de sincronización van después directamente de un navegador al otro, ' +
      'cifrados, sin pasar por ningún servidor de Cartouche. Si añades tu propio servidor TURN (Jugar en línea > ajustes ' +
      'de conexión), una conexión que no puede ser directa pasa por él.',
  },
  {
    title: 'Solicitudes de retirada',
    body:
      'Si crees que algo en Cartouche infringe tus derechos, abre una incidencia «Takedown request» ' +
      'en https://github.com/phmatray/cartouche/issues/new/choose (las incidencias son públicas). Para una ' +
      'solicitud no pública, usa el procedimiento DMCA de GitHub ' +
      '(https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy); el ' +
      'proyecto no tiene una dirección de correo privada.\n\n' +
      'El mantenedor procura responder en 72 horas. El contenido plausiblemente infractor se ' +
      'desactiva primero y se revisa después.',
  },
  {
    title: 'Código abierto',
    body:
      'Código fuente: https://github.com/phmatray/cartouche (licencia MIT). Los textos de las licencias de abajo ' +
      'se publican con la app, y THIRD_PARTY_NOTICES.md en el repositorio contiene los mismos avisos.',
    links: [
      { file: 'LICENSE.txt', label: 'Licencia de Cartouche (MIT)' },
      { file: 'THIRD_PARTY_NOTICES.txt', label: 'Avisos de terceros (juegos y cartuchos de prueba incluidos, GameDataBase, fuentes, carátulas)' },
      { file: 'licenses/GPL-3.0-ucity.txt', label: 'GNU GPL versión 3 (µCity)' },
      { file: 'roms/gbstudio/LICENSES.txt', label: 'Colección GB Studio: autores y licencias de los juegos alojados' },
      { file: 'THIRD_PARTY_LICENSES.txt', label: 'Licencias completas de los paquetes npm, crates de Rust y fuentes incluidos' },
    ],
  },
];
