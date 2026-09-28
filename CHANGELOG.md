# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.6.0](https://github.com/phmatray/cartouche/compare/v1.5.0...v1.6.0) (2026-09-28)


### Added

* **achievements:** unlock RetroAchievements while playing ([ee90635](https://github.com/phmatray/cartouche/commit/ee906352668be86d58cda3deb6b8a686fe5d25f9))
* **core:** read memory at RetroAchievements' Game Boy addresses ([25d1a76](https://github.com/phmatray/cartouche/commit/25d1a767033e65fd18852bd7ed628fce24f59f41))
* **relay:** relay RetroAchievements' emulator API for the web app ([87515fa](https://github.com/phmatray/cartouche/commit/87515fa1a5721f9c0dda9f0e292f72e3fad2caa5))


### Documentation

* **achievements:** describe unlocking, the relay and what it sends ([7ace36b](https://github.com/phmatray/cartouche/commit/7ace36b93d567adb6751e3a0d09ae661027c211f))

## [1.5.0](https://github.com/phmatray/cartouche/compare/v1.4.1...v1.5.0) (2026-09-28)


### Added

* **library:** give the four hosted GB Studio games their title screens as covers ([0e74989](https://github.com/phmatray/cartouche/commit/0e749893db4a2894c34d50ae94ab63e3d28940c1))
* **library:** show the itch.io covers of the other GB Studio games with box-art consent ([2798b8f](https://github.com/phmatray/cartouche/commit/2798b8f3be6f1c333c837c73ad02bbf77fcebea8))


### Fixed

* **backup:** export a few thousand save states without a string overflow ([795b2b4](https://github.com/phmatray/cartouche/commit/795b2b43e70f8535731ebfca4299b4d3f76524e5))
* **backup:** restore thousands of save states without holding them all ([aa8b9e4](https://github.com/phmatray/cartouche/commit/aa8b9e4a5cc7d2f9b010594f8101b42602f767ea))
* **backup:** say a backup with a missing or unknown version isn't valid ([4f0f7ec](https://github.com/phmatray/cartouche/commit/4f0f7ec00964b254efcc3b85a28e145a493484d8))
* **core:** clamp a damaged save state's serial transfer length ([f992458](https://github.com/phmatray/cartouche/commit/f992458b4d5632b62ad9eef94940c81fef92d611))
* **core:** find a .sav's clock footer from the end of the file ([f0f4391](https://github.com/phmatray/cartouche/commit/f0f4391b9c549b62274b9222522eb22e1023e840))
* **core:** keep KEY0 in save states ([1165eea](https://github.com/phmatray/cartouche/commit/1165eea69c15f3d2862086dbd8204336eb88b41c))
* **core:** STOP enters stop mode until a selected button is pressed ([87c8f68](https://github.com/phmatray/cartouche/commit/87c8f684fd57d016f9042af8ff467b1f90a507df))
* **game:** keep a big album from burying the game's saves ([0afee5e](https://github.com/phmatray/cartouche/commit/0afee5e43966bf900116068b85c0f048a7b7f19f))
* **gamepad:** B in the touch layout editor is Done, not back a page ([93dfa61](https://github.com/phmatray/cartouche/commit/93dfa612e21a6d756cbda195b37edf8d2eee20ca))
* **input:** bind buttons to physical keys, so Select + a digit plays ([3973b90](https://github.com/phmatray/cartouche/commit/3973b907edc97f8d4af6260b2fb0601fbfe953fc))
* **library:** forget a removed ROM's own screen settings ([2299128](https://github.com/phmatray/cartouche/commit/229912817244a0e73050c37c162297c9e7706944))
* **library:** keep the shelf rail short with a big collection ([2d5d616](https://github.com/phmatray/cartouche/commit/2d5d616d194f8d54afc19b4bd547516f29a45144))
* **library:** load a big collection without a quadratic merge ([9944b4c](https://github.com/phmatray/cartouche/commit/9944b4c4334fd13f16a5fdf68e95ef5d4b8445ce))
* **library:** move focus to the game an A–Z jump lands on in list view ([8ef115e](https://github.com/phmatray/cartouche/commit/8ef115e71b69c15498e2b497a8d0425feee976a7))
* **library:** reach the footer and draw the catalog fast with thousands of games ([e96363c](https://github.com/phmatray/cartouche/commit/e96363cd86eac2c82e8396c8e4dabe8e2cb8f564))
* **player:** a button stays down while any input still holds it ([f13b8a2](https://github.com/phmatray/cartouche/commit/f13b8a26a21eee5e1bd51d7093afa473d010f679))
* **player:** a touch button held when the window loses focus no longer looks stuck ([4eb34ca](https://github.com/phmatray/cartouche/commit/4eb34ca681e0eb7c6a79b0d114ec4b35f9fbaf56))
* **player:** don't flash the Paused card while a game launches ([2cb6f9c](https://github.com/phmatray/cartouche/commit/2cb6f9c264fdd1cf4534b648e02e03fb46a489a2))
* **player:** don't leak a console when leaving before the core loads ([96c9e8d](https://github.com/phmatray/cartouche/commit/96c9e8dd09cf0bd31ad7c953020ccdad4619649d))
* **settings:** a key rebound with Shift held binds the key, and dead keys don't bind ([d230793](https://github.com/phmatray/cartouche/commit/d2307937fddfb089e95a159eec4776c4f7f87860))
* **storage:** measure a big library without loading every save state ([81001c0](https://github.com/phmatray/cartouche/commit/81001c09572af75b07dcb28c51d2f827f5e5991d))
* **storage:** show backup progress and run one export at a time ([1f96416](https://github.com/phmatray/cartouche/commit/1f964161e027766999b94e4367f6a0181887fed3))
* **storage:** wrap a long title in the "Largest" line on a phone ([2961465](https://github.com/phmatray/cartouche/commit/29614653000b6e22eb9c7fe01b983e89334e4f4f))
* **sync:** deletions stay deleted on paired devices ([1868980](https://github.com/phmatray/cartouche/commit/186898041a4d673f60cd20d7b44ca59470357b31))
* **sync:** say when pairing can't reach any matchmaking relay ([93358cd](https://github.com/phmatray/cartouche/commit/93358cde6eb754ec42e1a131564c0c43725dcef0))
* **sync:** the default device name follows the language ([5d577f2](https://github.com/phmatray/cartouche/commit/5d577f20fd96a9264b8d088fbbb5db1a1b1ecf2b))
* **ui:** focus the confirm dialog's intended button ([58843bb](https://github.com/phmatray/cartouche/commit/58843bb68b87306189d7a1190a13c2b16181348a))
* **ui:** keep keyboard focus after a toast's action ([4c06db4](https://github.com/phmatray/cartouche/commit/4c06db45c7c255e5e628f5f273bf1442a5f2ce74))

## [1.4.1](https://github.com/phmatray/cartouche/compare/v1.4.0...v1.4.1) (2026-09-28)


### Fixed

* **a11y:** add a skip-to-content link ([008ad1d](https://github.com/phmatray/cartouche/commit/008ad1d59df69e5a51be2523f2e72886cc40f353))
* **a11y:** draw the focus ring in ink on paper surfaces ([7da51ab](https://github.com/phmatray/cartouche/commit/7da51ab166489158b9e92119826e09f9a3bb3663))
* **a11y:** keep the focus near a row deleted from a confirm dialog ([845bdd9](https://github.com/phmatray/cartouche/commit/845bdd9bfe314112a043dff5e809ae5fc0b24120))
* **a11y:** make every file picker a real button ([8278eb9](https://github.com/phmatray/cartouche/commit/8278eb98fccd365cda08edfd24e8958d4727a9f5))
* **audio:** bound the sound queued ahead of the device ([2c9ddbc](https://github.com/phmatray/cartouche/commit/2c9ddbcccf25dae51dd408400dca7c56398f06f9))
* **backup:** a restore keeps the backup's solo save for a game known here ([7c69872](https://github.com/phmatray/cartouche/commit/7c698723ad5d47a8a82ff52faba5a7a28f46a04c))
* **backup:** a restored save state without a picture no longer breaks Storage ([b73c97b](https://github.com/phmatray/cartouche/commit/b73c97b6900175cd367071826192d75552b2f564))
* **backup:** say when a backup can't be exported ([43c0844](https://github.com/phmatray/cartouche/commit/43c0844cc5ca3295414b79a3bcfd61a7b6bad901))
* **camera:** release a camera granted after leaving the player ([a267d63](https://github.com/phmatray/cartouche/commit/a267d6313993bf0abe679938662b9de403c92a3d))
* **core:** clamp a damaged save state's PPU line, line clock and HDMA ([4e46009](https://github.com/phmatray/cartouche/commit/4e46009869e4518980f02d8c65cba77b279c7385))
* **core:** enable MBC2 RAM on any value whose low nibble is $A ([a127528](https://github.com/phmatray/cartouche/commit/a12752891a1f3f2cb367251265b7283042ae0a90))
* **core:** give the DMG no fast serial clock and read SC's unused bits as 1 ([1e82434](https://github.com/phmatray/cartouche/commit/1e824348797845d969fb47ae302e61549fe3dda1))
* **core:** keep the MBC3 clock's day carry until the game writes DH ([cbb3eed](https://github.com/phmatray/cartouche/commit/cbb3eedcece116359d7c8ed204c1ea4afbbde024))
* **core:** raise the timer interrupt when a DIV or TAC write overflows TIMA ([1691363](https://github.com/phmatray/cartouche/commit/16913639ce03ab24a8acc722d4d046cfa64cb972))
* **core:** reach every ROM bank when the header understates the ROM size ([42f868d](https://github.com/phmatray/cartouche/commit/42f868d017a16aecc911a1a0cc871827b63822a5))
* **core:** request the joypad interrupt when P1 selects a held button ([eb7bb00](https://github.com/phmatray/cartouche/commit/eb7bb000687717d97ed82b9003fcdc58d0c144b9))
* **display:** keep the screen previews from looping their resize in Safari ([100178b](https://github.com/phmatray/cartouche/commit/100178b1e0407e49bffa20440868cbf46ce94b52))
* **gamepad:** a dialog over the running game takes the pad ([ab2f7aa](https://github.com/phmatray/cartouche/commit/ab2f7aa31e77fb9dd80d07d1e334f4930accfe48))
* **gamepad:** a direction held on the D-pad survives the stick coming back ([1ad2611](https://github.com/phmatray/cartouche/commit/1ad2611403faecf98c93f9a6641f552d25233386))
* **gamepad:** Home no longer starts the game under the touch layout editor ([7e624d5](https://github.com/phmatray/cartouche/commit/7e624d5365869211291615191dfb770f7525883d))
* **gamepad:** the pads still plugged in keep playing when another one leaves ([42e3437](https://github.com/phmatray/cartouche/commit/42e34379daec06529d7dbbca4713c19cee867d61))
* **i18n:** agree "point" with the points earned in French ([afe4c41](https://github.com/phmatray/cartouche/commit/afe4c4179c7b03aab6db7c376bb00bd7efe00678))
* **i18n:** name the audio channels in French ([a94c284](https://github.com/phmatray/cartouche/commit/a94c2842838197be3b76975e9320b27e471887d3))
* **import:** a zip with nothing to add says so ([c0c08e8](https://github.com/phmatray/cartouche/commit/c0c08e809a2f609160412392db580ec42b14fa59))
* **library:** a new game no longer inherits a removed game's stats ([85eeed4](https://github.com/phmatray/cartouche/commit/85eeed4d761cd84f772a7d7ab6d93541217a9d39))
* **library:** a ROM added in another tab isn't stored a second time ([62cdbcc](https://github.com/phmatray/cartouche/commit/62cdbccba59af6325957ed1a2ed55f5395eb9c43))
* **library:** let Add to favorites work when storage is blocked ([539f5f3](https://github.com/phmatray/cartouche/commit/539f5f3a88b00e4407f8ac9397fe3cca4982d2d8))
* **library:** removing a game that plays in another tab no longer half-works ([6d15f82](https://github.com/phmatray/cartouche/commit/6d15f82666fd128a4316ac1d324b43bac65dac6a))
* **link:** a key let go while Ctrl, Alt or Meta is held is released ([1f54cb2](https://github.com/phmatray/cartouche/commit/1f54cb2b646c273d947c609503d3e62dcfc69a28))
* **link:** keys held when the window loses focus are let go ([3e39282](https://github.com/phmatray/cartouche/commit/3e392826a9566f0bdf66da08b05c13b4eb04276b))
* **link:** name Enter and Shift in the player's language ([890a9d3](https://github.com/phmatray/cartouche/commit/890a9d35ebbcf205c23825881eaa018a72f895a4))
* **netlink:** say when an invite link holds no valid room code ([516aa05](https://github.com/phmatray/cartouche/commit/516aa059d10b0bd3edf1b5bd024e39731fe96eb5))
* **netlink:** say when no matchmaking relay can be reached ([d002075](https://github.com/phmatray/cartouche/commit/d0020752056e2a3088ea4cd1b91c83ac886d2f4b))
* **netlink:** tell the player when the invite can't be copied ([46ab86f](https://github.com/phmatray/cartouche/commit/46ab86f5fd449210e0611eae27d033aa4ffb3b89))
* **player:** a button bound to Control, Alt or Meta now presses ([d45cc86](https://github.com/phmatray/cartouche/commit/d45cc86cc8a386c5862187584e69367d9003352c))
* **player:** drop frames over the per-refresh cap instead of owing them ([bb8df97](https://github.com/phmatray/cartouche/commit/bb8df97fb8cc5d27bf3d404f015bf8d2b7f4f57c))
* **player:** fullscreen on a phone keeps the touch controls ([a6713e6](https://github.com/phmatray/cartouche/commit/a6713e65736d46265e0b6522ae8736230d750e15))
* **player:** give the player page a main landmark ([35c53ca](https://github.com/phmatray/cartouche/commit/35c53caa7cbcb169c2c67d26b1f388adafd68702))
* **player:** let the arrow keys move a Manual slider reached by Tab ([6657eb7](https://github.com/phmatray/cartouche/commit/6657eb7b6560f483a547e886bdc68083fb0c2ce0))
* **player:** no unhandled errors from F8 or leaving a game when storage is blocked ([71c1995](https://github.com/phmatray/cartouche/commit/71c1995c45093b85d8f8d6d8bf170c81b1e5cbc2))
* **player:** read the half speed with the language's decimal sign ([5ab2d24](https://github.com/phmatray/cartouche/commit/5ab2d2441d6488b99eff8c390ec2f2a724fbcd10))
* **player:** release a key's button even when Shift changed its character ([ca963c9](https://github.com/phmatray/cartouche/commit/ca963c9d517fe18c3107563669b99194d06642f5))
* **player:** show a translated error with a retry when the emulator core fails to load ([1e586d4](https://github.com/phmatray/cartouche/commit/1e586d428bb015b5cfe620020e93f0bfae42bc6f))
* **player:** the fullscreen button says when it leaves fullscreen ([5c35e2e](https://github.com/phmatray/cartouche/commit/5c35e2e5866160937ae974bc59126a001eaf3a9c))
* **player:** the fullscreen deck shows while a gamepad's focus is on it ([7df6aaf](https://github.com/phmatray/cartouche/commit/7df6aafa1474102a9f6c55469fca533b9c4688ec))
* **player:** the game waits when a tablet turned upright puts the Manual over it ([3d0769e](https://github.com/phmatray/cartouche/commit/3d0769e674222ab72fbbf30a286032ffd6250477))
* **router:** open the library at /index.html instead of a not-found page ([1dd5cf4](https://github.com/phmatray/cartouche/commit/1dd5cf435e33bfc83458fa248a68cda642351d10))
* **saves:** keep the clock of an MBC3+TIMER+BATTERY cartridge without RAM ([d2e4c8d](https://github.com/phmatray/cartouche/commit/d2e4c8d0ce80003deadcf2b0f5bdf2efc2e6ce1b))
* **saves:** say when renaming, copying or deleting a save fails ([d8bc53e](https://github.com/phmatray/cartouche/commit/d8bc53ece7e3d88eb139511af12f974dcc5d27e3))
* **saves:** undoing New game no longer writes over another save profile ([27d8873](https://github.com/phmatray/cartouche/commit/27d88734c1f9fbd2e8de00fb01e9acaf4543ce50))
* **settings:** keep a setting changed in another tab ([0a61c03](https://github.com/phmatray/cartouche/commit/0a61c03f690a5952c8049f14a30589532d187f3c))
* **shell:** keep a toast while it is hovered or focused ([4027dcb](https://github.com/phmatray/cartouche/commit/4027dcb53326cd885922dcd4ba15d9cda0e2f2d2))
* **shell:** let the app recover from a page crash when the player navigates away ([93ff9e9](https://github.com/phmatray/cartouche/commit/93ff9e9389e252cb2b8e7f98ee0edfd6a610b2d1))
* **storage:** Erase everything waits for games open in other tabs ([06c96e3](https://github.com/phmatray/cartouche/commit/06c96e3ff80a4bd93b2a04a5a983df7dc5a54521))
* **storage:** give the backup file picker its name back ([73be37f](https://github.com/phmatray/cartouche/commit/73be37fb3795ef78c6547340abe5010ec3fedcdb))
* **storage:** no unhandled error on Settings &gt; Storage when storage is blocked ([aefa3f4](https://github.com/phmatray/cartouche/commit/aefa3f445e4ff13963d2072d379b83fc405f96e5))

## [1.4.0](https://github.com/phmatray/cartouche/compare/v1.3.0...v1.4.0) (2026-09-27)


### Added

* **player:** the pause card offers Resume and New game ([370d932](https://github.com/phmatray/cartouche/commit/370d932944eaced762f6a553ed4a02daf4fb432b))
* **saves:** a New game button beside Resume, with a moment to undo it ([433a998](https://github.com/phmatray/cartouche/commit/433a9984973a37e7113849c394552cbfd3430de6))
* **saves:** delete a slot or the resume point from the game page ([7ed3d00](https://github.com/phmatray/cartouche/commit/7ed3d00afc0a8b9f9e64b9d4cb961324cf98c985))


### Fixed

* **add:** import results keep the title readable on phones ([ad45387](https://github.com/phmatray/cartouche/commit/ad453879bf93bedcc114364574537f10fa0f8fdc))
* **game:** the hero's buttons stack evenly on tablets and phones held sideways ([b371850](https://github.com/phmatray/cartouche/commit/b371850d2b5b17b15ff2fd3db8fa27430d943728))
* **game:** the save buttons are 44 px tall on touch screens ([b4b3333](https://github.com/phmatray/cartouche/commit/b4b33333aaa9b329430629ee4b4424e71e14a617))
* **library:** "Show all" in an empty filter stays on one line ([12850d5](https://github.com/phmatray/cartouche/commit/12850d5e6a8f7014e997e43786e649e78e41b37b))
* **library:** an empty Favorites filter says how to add one ([75d638f](https://github.com/phmatray/cartouche/commit/75d638f7f780140c075e29613f40a25901c59f8e))
* **library:** list view column headings share one baseline ([7c0b5f7](https://github.com/phmatray/cartouche/commit/7c0b5f73d06b6437eda2cfe4127df4c62d707847))
* **library:** printed covers no longer split short words ("Pof-fin", "Spi-der") ([30aeec1](https://github.com/phmatray/cartouche/commit/30aeec12095b9eec9a8a0c2e498ac68d96e23608))
* **library:** the A–Z jump on touch phones leaves one empty cell, not five ([c7f95be](https://github.com/phmatray/cartouche/commit/c7f95beb132d455b6f970625a35119a1b68721d5))
* **library:** the demo caption keeps "Free homebrew" on one line ([1fc4861](https://github.com/phmatray/cartouche/commit/1fc4861e6b1543035061e7d836d7b3bb6db93a57))
* **link:** the link cable no longer starts on a test cartridge ([1c67593](https://github.com/phmatray/cartouche/commit/1c675932664889f673410ce372f580675467035f))
* **online:** the room code field shows the whole code on phones ([d913041](https://github.com/phmatray/cartouche/commit/d91304163f860c35626fa4f504a514230e6f47a0))
* **player:** notices on a sideways phone keep to a corner instead of a bar across the game ([053a874](https://github.com/phmatray/cartouche/commit/053a8749db0a6f52acf22e051f710dbd11f0d9de))
* **player:** on phones, Start and Select work while a notice is showing ([1005dc4](https://github.com/phmatray/cartouche/commit/1005dc4eb77fb77ba2effb8045d5cdfa6e3e9a0c))
* **player:** screen preset previews no longer show a coarse checkerboard ([9c6d3a7](https://github.com/phmatray/cartouche/commit/9c6d3a74eccbfa9729d8741d8c5c12e163a1f15d))
* **player:** screen preset previews no longer show a ghost of an earlier frame ([ed7974d](https://github.com/phmatray/cartouche/commit/ed7974d8c8562ba608793e238a5b39f445debf0a))
* **player:** tablets held upright get Load, Photo and Mute in the dock ([e69f574](https://github.com/phmatray/cartouche/commit/e69f574e5a779342100da5fdc291457796359576))
* **player:** the bottom dock no longer overlaps its labels on laptops and small screens ([f8e7e52](https://github.com/phmatray/cartouche/commit/f8e7e52b024cba357c4cc6971b77c741db396f4c))
* **player:** the layout editor no longer shows the Paused card under its grid ([8affce4](https://github.com/phmatray/cartouche/commit/8affce4de992c06abc9716dce0306c8b28268e5d))
* **player:** the manual's tab labels get room to breathe ([e351ef7](https://github.com/phmatray/cartouche/commit/e351ef7af389aca22f92f8a304aa7be02385e6b9))
* **player:** the screen sliders share one width and one left edge ([b3ec0d7](https://github.com/phmatray/cartouche/commit/b3ec0d71e6970f615469d5d48371eb2c3e99873e))
* **player:** the Upscaling choice fills its row, no empty first cell, labels no longer crammed ([5d26545](https://github.com/phmatray/cartouche/commit/5d26545f101abe0d21705c9457483dfe49a6bee1))
* **saves:** a quick save over a filled slot can be undone ([41c063e](https://github.com/phmatray/cartouche/commit/41c063e92d4d9964bc004dc6d789a6835a396ec6))
* **saves:** Save and Load sit side by side in the phone's Saves page ([1a9d7d8](https://github.com/phmatray/cartouche/commit/1a9d7d83eeffa64e62388cf4d3739c5c7b752d4c))
* **saves:** say what a slot, the resume point and the cartridge save each are ([c23ec31](https://github.com/phmatray/cartouche/commit/c23ec31cc7d44c81df3eeabc2ccb423c530116ba))
* **saves:** the game page's slots show the day and time they were made ([97d2f96](https://github.com/phmatray/cartouche/commit/97d2f9629429e828c65aacf373bd6fa7b1c67c25))
* **saves:** the resume point's button reads like the hero's ([c2e87d0](https://github.com/phmatray/cartouche/commit/c2e87d09e1eaa7a46991b8f4d8048c17fc604391))
* **search:** "no game called …" links to Add ROMs ([e74b482](https://github.com/phmatray/cartouche/commit/e74b482eb7bb94384efadb0ab3836776a9b24d0d))
* **settings:** deleting downloaded box art asks first ([489c17b](https://github.com/phmatray/cartouche/commit/489c17b356dea823a475d7ba161a154ce916b43c))
* **settings:** key binding rows keep a compact Change button on tablets and phones ([fd43c0b](https://github.com/phmatray/cartouche/commit/fd43c0b2319632ce2985e1838d630388abd2c663))
* **settings:** on phones the open section scrolls into the contents row, which fades at the edge ([60c729e](https://github.com/phmatray/cartouche/commit/60c729e326ecfc7b5ffd57367e4a636bedac707f))
* **settings:** resetting the keys can be undone ([7208337](https://github.com/phmatray/cartouche/commit/7208337f21ccdfb570bdf3bd3a9e51ba0513400d))
* **settings:** segmented choices match on phones ([f3d4c23](https://github.com/phmatray/cartouche/commit/f3d4c2332dfcd30b53d65e57cff3e4cdb3792029))
* **settings:** storage says ROM in French and Spanish, and one game is "never played" ([33ed513](https://github.com/phmatray/cartouche/commit/33ed5135b716e3459461734d8ab198362301ee8b))
* **settings:** the gamepad map stacks to one column on phones ([53bc6af](https://github.com/phmatray/cartouche/commit/53bc6af6ae6b33ab53c78dd18dec2e85bdd62919))
* **settings:** volume and rewind sliders stop announcing every step while dragged ([3593272](https://github.com/phmatray/cartouche/commit/3593272203fbb968650338b97b3cccdb6d9c2c88))
* **shell:** footer groups the promise, the links and the small print, with a compact language switch ([44c2318](https://github.com/phmatray/cartouche/commit/44c231835da9616fb2826f580ee043275f42aa8b))
* **shell:** header search stays on one line and the menu button stays on screen on tablets ([f63c356](https://github.com/phmatray/cartouche/commit/f63c356e4bb255c663c371567a7fc98c234a9983))
* **shell:** long toasts wrap at a readable width ([958063e](https://github.com/phmatray/cartouche/commit/958063ecf89a8e4b23542550a2e60b446b045aec))
* **shell:** the 404 headline no longer hyphenates on phones ([1b103c9](https://github.com/phmatray/cartouche/commit/1b103c977c2a7e893fdf3c7003cd48836a6320e7))
* **shell:** the phone menu fits in landscape with page left to tap ([fb68a22](https://github.com/phmatray/cartouche/commit/fb68a220062e8522e186da505609f8b0cdf54dad))

## [1.3.0](https://github.com/phmatray/cartouche/compare/v1.2.1...v1.3.0) (2026-09-27)


### Added

* Cartouche start-up animations (Registration, Insert, Shelf) ([#89](https://github.com/phmatray/cartouche/issues/89)) ([9b8bc8a](https://github.com/phmatray/cartouche/commit/9b8bc8a857a6cd3045660beabb82bbd89f35ee34))
* play the link cable online, browser to browser ([#42](https://github.com/phmatray/cartouche/issues/42)) ([6f6addf](https://github.com/phmatray/cartouche/commit/6f6addfa35ebf41aaba451d3be20b8b142a45a41))
* pocket camera, Game Boy Printer and rumble ([#37](https://github.com/phmatray/cartouche/issues/37)) ([57e28d9](https://github.com/phmatray/cartouche/commit/57e28d959c9de87886ba1e0a5f98627036eeff17))
* start-up animation and Game Boy Color colours for original Game Boy games ([#49](https://github.com/phmatray/cartouche/issues/49)) ([704439a](https://github.com/phmatray/cartouche/commit/704439a4e728ecb7bfb496a74de98b21e6206533))
* Super Game Boy borders, colours and multiplayer ([#50](https://github.com/phmatray/cartouche/issues/50)) ([fded9eb](https://github.com/phmatray/cartouche/commit/fded9eb8667b8b56a1b28fedaab688ac7ceeac66))
* **web:** add a GB Studio collection with one-tap downloads ([#39](https://github.com/phmatray/cartouche/issues/39)) ([7a7941f](https://github.com/phmatray/cartouche/commit/7a7941fc9cbf174867aec9118f4a6095b44f0928))
* **web:** an option to hide the test cartridges ([#43](https://github.com/phmatray/cartouche/issues/43)) ([174ec20](https://github.com/phmatray/cartouche/commit/174ec20f2d0b31914d243219b031e2c997debb4c))
* **web:** English, French and Spanish ([#36](https://github.com/phmatray/cartouche/issues/36)) ([0ddfd4c](https://github.com/phmatray/cartouche/commit/0ddfd4c192448db8dac48f1149174078ac5f9c76))
* **web:** read-only RetroAchievements on the game page and in the manual ([#47](https://github.com/phmatray/cartouche/issues/47)) ([72a6d96](https://github.com/phmatray/cartouche/commit/72a6d9698922c85c83708a9ebcdc560f87f7865d))
* **web:** show the version in the footer ([#46](https://github.com/phmatray/cartouche/issues/46)) ([ec69d2e](https://github.com/phmatray/cartouche/commit/ec69d2e93d899da8b8ce4176f7c1159acf2f731c))
* **web:** sync saves between your own devices, end to end encrypted ([#45](https://github.com/phmatray/cartouche/issues/45)) ([0da0ad4](https://github.com/phmatray/cartouche/commit/0da0ad49fa3313cb3d6ad0912777b3d024c8432e))
* **web:** touch control skins and a layout editor ([#48](https://github.com/phmatray/cartouche/issues/48)) ([0195045](https://github.com/phmatray/cartouche/commit/0195045808e9ca42cadfd12be51cf728d8c745be))


### Fixed

* **audio:** suspend the audio device while paused or hidden ([#54](https://github.com/phmatray/cartouche/issues/54)) ([748190a](https://github.com/phmatray/cartouche/commit/748190a6c9f0a241df8aa65451c0cccb85b090d4))
* **core:** draw the first frame after a state load over its thumbnail ([#91](https://github.com/phmatray/cartouche/issues/91)) ([f064152](https://github.com/phmatray/cartouche/commit/f0641520a46e420b17291dca1d6da5190aaafeae))
* **core:** release review round 1 — Emulation core ([#52](https://github.com/phmatray/cartouche/issues/52)) ([9c43b5d](https://github.com/phmatray/cartouche/commit/9c43b5df31be8766b1d5ec2482d88892675ee514))
* **core:** release review round 2 — Emulation core ([#66](https://github.com/phmatray/cartouche/issues/66)) ([ca115a8](https://github.com/phmatray/cartouche/commit/ca115a87a4485c36de7c55a1853dbff17286e67d))
* **core:** release review round 3 — Emulation core ([#70](https://github.com/phmatray/cartouche/issues/70)) ([ba2f7d6](https://github.com/phmatray/cartouche/commit/ba2f7d6ae51ccfaeaeb91bc1c5565480a6ccbe61))
* **core:** release review round 4 — Emulation core ([#79](https://github.com/phmatray/cartouche/issues/79)) ([ef88bfd](https://github.com/phmatray/cartouche/commit/ef88bfdb6f438c6dfa3bde33c84df6cefe9615e9))
* **i18n:** release review round 3 — Translations and accessibility ([#72](https://github.com/phmatray/cartouche/issues/72)) ([ccefd83](https://github.com/phmatray/cartouche/commit/ccefd83a98ab86ab95f505cc932f155d4b08b416))
* **i18n:** release review round 4 — Translations and accessibility ([#80](https://github.com/phmatray/cartouche/issues/80)) ([8881b2a](https://github.com/phmatray/cartouche/commit/8881b2a5edd293a521f34f1d5cb429f513b57a1c))
* **i18n:** release review round 5 — Translations and accessibility ([#85](https://github.com/phmatray/cartouche/issues/85)) ([c8a6a2c](https://github.com/phmatray/cartouche/commit/c8a6a2c504243d1dd6dff95a7de0a295af414d9c))
* **legal:** open license files in a new browsing context ([#76](https://github.com/phmatray/cartouche/issues/76)) ([b2e66e7](https://github.com/phmatray/cartouche/commit/b2e66e7a5f45b79083d7f55f47325d8d5554b23c))
* **legal:** release review round 1 — Legal, licensing and security ([#51](https://github.com/phmatray/cartouche/issues/51)) ([732c0fe](https://github.com/phmatray/cartouche/commit/732c0fe9099e12baa290e586f3c4b992581a9617))
* **legal:** release review round 2 — Legal, licensing and security ([#59](https://github.com/phmatray/cartouche/issues/59)) ([806c41a](https://github.com/phmatray/cartouche/commit/806c41af78e86249f2d42f8f9f62788010d10da1))
* **legal:** release review round 4 — Legal, licensing and security ([#77](https://github.com/phmatray/cartouche/issues/77)) ([79689f7](https://github.com/phmatray/cartouche/commit/79689f737ddc6264b5d5ff55f19b852f28fc8d0c))
* **legal:** release review round 5 — Legal, licensing and security ([#84](https://github.com/phmatray/cartouche/issues/84)) ([9247933](https://github.com/phmatray/cartouche/commit/9247933f9d9ab9aa0c758b6a5287ecef55f505e5))
* **library:** release review round 4 — Library, import and storage ([#78](https://github.com/phmatray/cartouche/issues/78)) ([fff9a08](https://github.com/phmatray/cartouche/commit/fff9a08614455a949b9378536b56d4d2db2611fd))
* **library:** release review round 5 — Library, import and storage ([#88](https://github.com/phmatray/cartouche/issues/88)) ([d604f40](https://github.com/phmatray/cartouche/commit/d604f4070b6491ad4aa8f342a53abc1126601287))
* **neural:** draw curves smoothly instead of as zigzags, keep straight edges exact ([#40](https://github.com/phmatray/cartouche/issues/40)) ([a11efdd](https://github.com/phmatray/cartouche/commit/a11efdd9fc82ce4e1ff8ff37f9f01ede93667466))
* **player:** pause under the phone Manual, SNES-music resume, restart, Enter on focused buttons ([#82](https://github.com/phmatray/cartouche/issues/82)) ([7aec36a](https://github.com/phmatray/cartouche/commit/7aec36a581dcb399a8110f4450c074edea08952c))
* **player:** release review round 1 — Player and input ([#53](https://github.com/phmatray/cartouche/issues/53)) ([529c285](https://github.com/phmatray/cartouche/commit/529c2857f1382e5b524db55fa284d008dc3071f4))
* **player:** release review round 3 — Player and input ([#68](https://github.com/phmatray/cartouche/issues/68)) ([ae4c015](https://github.com/phmatray/cartouche/commit/ae4c015008f16b22ea5b5e873fd1a07986691caa))
* **player:** release review round 5 — Player and input ([#86](https://github.com/phmatray/cartouche/issues/86)) ([bdb1f4a](https://github.com/phmatray/cartouche/commit/bdb1f4a87eca99236356928cef70cdfdf12d1ebd))
* **pwa:** don't activate an update while another tab is open ([#62](https://github.com/phmatray/cartouche/issues/62)) ([d9f7556](https://github.com/phmatray/cartouche/commit/d9f7556403ae9f7415bee99969f1317a06f4acc6))
* **pwa:** release review round 1 — PWA, offline and iPhone ([#55](https://github.com/phmatray/cartouche/issues/55)) ([f794be0](https://github.com/phmatray/cartouche/commit/f794be07032fb92e51e485424f2c25dce1390205))
* **pwa:** release review round 3 — PWA, offline and iPhone ([#73](https://github.com/phmatray/cartouche/issues/73)) ([2203dba](https://github.com/phmatray/cartouche/commit/2203dbacbbf8a7b7b64d8f209b5ca2267e6f95aa))
* **pwa:** release review round 5 — PWA, offline and iPhone ([#90](https://github.com/phmatray/cartouche/issues/90)) ([d06af49](https://github.com/phmatray/cartouche/commit/d06af4915615c5426ba5296162dfcd4331697ae2))
* release review round 2 — Data integrity, sync and online link ([#64](https://github.com/phmatray/cartouche/issues/64)) ([095ba80](https://github.com/phmatray/cartouche/commit/095ba8065d7c8e7368010a4282c8c9a890cf2269))
* release review round 2 — Performance ([#63](https://github.com/phmatray/cartouche/issues/63)) ([2f234c7](https://github.com/phmatray/cartouche/commit/2f234c7d61dd7513795432956d139c012948048b))
* release review round 3 — legal, data and library (combined) ([#75](https://github.com/phmatray/cartouche/issues/75)) ([c239559](https://github.com/phmatray/cartouche/commit/c2395595ee8293ac9394d50cb13dd81217d5b72d))
* release review round 4 — Data integrity, sync and online link ([#81](https://github.com/phmatray/cartouche/issues/81)) ([e9c4c06](https://github.com/phmatray/cartouche/commit/e9c4c06fccf1bdb1e6c656772d4782296a399039))
* release review round 4 — Performance ([#83](https://github.com/phmatray/cartouche/issues/83)) ([b2a3072](https://github.com/phmatray/cartouche/commit/b2a30721b4bf07812a3f885b8a5d66971f67a7ee))
* **search:** keep keys typed while the debounced URL update lands ([#93](https://github.com/phmatray/cartouche/issues/93)) ([c7aaffa](https://github.com/phmatray/cartouche/commit/c7aaffab2b540eb51e9970d0d448e239dfcd3853))
* **sync:** release review round 5 — Data integrity, sync and online link ([#87](https://github.com/phmatray/cartouche/issues/87)) ([1a5bf8f](https://github.com/phmatray/cartouche/commit/1a5bf8f9d33dca39e8cdeaf3973544b100ff8a40))
* **web:** quick wins (zip on Load your ROM, 404 message, wake lock, share, streamed backup, iPhone touch) ([#44](https://github.com/phmatray/cartouche/issues/44)) ([193fcaf](https://github.com/phmatray/cartouche/commit/193fcaf7d6c11687886eab1bb3465538c66271d5))
* **web:** release review round 1 — data integrity, sync and online link ([#56](https://github.com/phmatray/cartouche/issues/56)) ([1ea9916](https://github.com/phmatray/cartouche/commit/1ea991610478ed20656eeb12e9b62684bce845b0))
* **web:** release review round 1 — Library, import and storage ([#58](https://github.com/phmatray/cartouche/issues/58)) ([d72885b](https://github.com/phmatray/cartouche/commit/d72885b52168fbf3a59cfde321a780bc775bc62c))
* **web:** release review round 1 — Translations and accessibility ([#57](https://github.com/phmatray/cartouche/issues/57)) ([9073ffe](https://github.com/phmatray/cartouche/commit/9073ffef0f0208a73be63e8acd214e06680ec3a1))
* **web:** release review round 2 — Library, import and storage ([#60](https://github.com/phmatray/cartouche/issues/60)) ([3c6a9d3](https://github.com/phmatray/cartouche/commit/3c6a9d378534db5f3c88ca8f7ff5ada4b429d315))
* **web:** release review round 2 — Player and input ([#61](https://github.com/phmatray/cartouche/issues/61)) ([b892f08](https://github.com/phmatray/cartouche/commit/b892f0834ed36f8da1c9d796978e5733d76741ff))
* **web:** release review round 2 — Translations and accessibility ([#65](https://github.com/phmatray/cartouche/issues/65)) ([ed2643a](https://github.com/phmatray/cartouche/commit/ed2643a1800cf79778374d0dcb194d62ad4de4ab))
* **web:** release review round 3 — Performance ([#74](https://github.com/phmatray/cartouche/issues/74)) ([e56ead4](https://github.com/phmatray/cartouche/commit/e56ead40180ade9e049f8fc89fe24738bd5e5ab1))


### Documentation

* docs/SYNC.md (design, threat model, limits). ([0da0ad4](https://github.com/phmatray/cartouche/commit/0da0ad49fa3313cb3d6ad0912777b3d024c8432e))
* refresh the README and screenshots for the release ([#92](https://github.com/phmatray/cartouche/issues/92)) ([5167afb](https://github.com/phmatray/cartouche/commit/5167afb66cbeab52cbb3f7964c8cc38ddd4e62fb))

## [1.2.1](https://github.com/phmatray/cartouche/compare/v1.2.0...v1.2.1) (2026-09-27)


### Fixed

* **web:** mobile design pass: menu, player and long titles ([#34](https://github.com/phmatray/cartouche/issues/34)) ([2d4ea0d](https://github.com/phmatray/cartouche/commit/2d4ea0d8e8b6227ec7e5fb2d41275cea60b60412))

## [1.2.0](https://github.com/phmatray/cartouche/compare/v1.1.0...v1.2.0) (2026-09-27)


### Added

* neural upscaling and exact-motion frame generation ([#33](https://github.com/phmatray/cartouche/issues/33)) ([c7c1bc9](https://github.com/phmatray/cartouche/commit/c7c1bc9b65eab8d4f8078d8a90f4f30b1414f144))
* **web:** install from the menu, and import ROM folders from iPhone (zip) ([#32](https://github.com/phmatray/cartouche/issues/32)) ([2ba3b90](https://github.com/phmatray/cartouche/commit/2ba3b9033f4405457c5aa263f392247997355fee))
* **web:** installable on iPhone (PWA) ([#28](https://github.com/phmatray/cartouche/issues/28)) ([36164ed](https://github.com/phmatray/cartouche/commit/36164ed6715efb2cc48140e422131ba401285416))
* **web:** search by tags and metadata ([#30](https://github.com/phmatray/cartouche/issues/30)) ([775b86c](https://github.com/phmatray/cartouche/commit/775b86cbd9194a9b21376ba3e0705ef15f7cda32))
* **web:** shared-element page transitions ([#31](https://github.com/phmatray/cartouche/issues/31)) ([ac2f599](https://github.com/phmatray/cartouche/commit/ac2f5998ad74c150c42940270b074d808120cbe3))


### Fixed

* **deps:** update dependency react-router to v8 ([#27](https://github.com/phmatray/cartouche/issues/27)) ([5857e35](https://github.com/phmatray/cartouche/commit/5857e35026d2074802992c67b799d7b20c6053e8))
* **web:** opaque status bar in the installed iPhone app ([5379a15](https://github.com/phmatray/cartouche/commit/5379a15b61cfb94fe9364f75cfcf1883431f63be))
* **web:** ROMs, saves and backups are selectable in the iPhone file picker ([0a35844](https://github.com/phmatray/cartouche/commit/0a358446e869eb5a6fe8c5e7b6b78d34f750a1ab))
* **web:** screen presets show their previews in the player ([f6deff1](https://github.com/phmatray/cartouche/commit/f6deff1df750144afb94158e7448e26964d8713e))


### Changed

* keep gb-core's Cargo.lock version in step on release ([200aec4](https://github.com/phmatray/cartouche/commit/200aec459c7fab883b79b44738b908c59e1dd8fc))

## [1.1.0](https://github.com/phmatray/cartouche/compare/v1.0.0...v1.1.0) (2026-09-26)


### Added

* **display:** composable screen filter pipeline with presets ([3a08687](https://github.com/phmatray/cartouche/commit/3a08687ffd9f6e7405dc7d1dd7dfe6840062562c))
* **link-cable:** cartridge picker that scales to large libraries ([cf9fff9](https://github.com/phmatray/cartouche/commit/cf9fff97d6db005e44ce0754dd13f34accb9b410))
* **saves:** save profiles, and a save of its own for each link cable player ([95a4332](https://github.com/phmatray/cartouche/commit/95a4332ee510651fac2abdd7f549138ba450f060))
* **web:** add OpenGraph, Twitter card and JSON-LD metadata ([7cfd824](https://github.com/phmatray/cartouche/commit/7cfd824d4e5a1ca2c8206d9bb94c0ca7ca9843b4))
* **web:** box art progress bar and a Storage page that scales ([52cb3c4](https://github.com/phmatray/cartouche/commit/52cb3c464fda4891cca8c0ac01c97ad46f8571af))
* **web:** link to the source on GitHub ([c527a0d](https://github.com/phmatray/cartouche/commit/c527a0d086637298db391c645268ed289311d6e6))
* **web:** list a game's save profiles in Storage › Per game ([ed164ba](https://github.com/phmatray/cartouche/commit/ed164ba4ce04b35257904c60f56e0891de038b4e))
* **web:** ship the official covers of the Tobu Tobu Girl games ([a167fb5](https://github.com/phmatray/cartouche/commit/a167fb52db180f216260acbae2c06b8e7c5e03d6))


### Fixed

* **display:** review fixes for the screen filters ([b3e5e00](https://github.com/phmatray/cartouche/commit/b3e5e003cc958eda9931282c67c6e9950860d5a8))
* **link-cable:** accent- and word-aware search, open on the right section ([979ea02](https://github.com/phmatray/cartouche/commit/979ea02ac27ee7ab33008f8b0a364bd77748fefc))
* **saves:** keep each profile's progress safe across states, unloads and upgrades ([d6c9944](https://github.com/phmatray/cartouche/commit/d6c9944f7b1ec291b881b63b4f5f5fb35cd0dacf))
* **web:** keep play time when the tab reloads or closes ([b88ccf8](https://github.com/phmatray/cartouche/commit/b88ccf8d5862f8e7ede2a4ca890bce3246154691))
* **web:** keyboard and focus fixes for Storage › Per game ([ae80e31](https://github.com/phmatray/cartouche/commit/ae80e316dbbbf195a3b1e0dd56316157e01fb4c2))
* **web:** line up every box on a shelf by its top edge ([a4d5255](https://github.com/phmatray/cartouche/commit/a4d5255ed5e6e9ad469261d2f117af39a291950b))
* **web:** make rewind run backwards on screen while R is held ([aa33d84](https://github.com/phmatray/cartouche/commit/aa33d84461517594ce1dd586a65b9f2fdb5016fd))
* **web:** old backups keep their screen style; state loads redraw at once ([f3ac5ac](https://github.com/phmatray/cartouche/commit/f3ac5acb4225ad528b491b9105dd800e558cd357))
* **web:** rewind the first step on press ([f92caf1](https://github.com/phmatray/cartouche/commit/f92caf1a1a321e5bfb4e5e8843e974e368d5a362))
* **web:** show the first rewind step on the next frame ([ac2d6b7](https://github.com/phmatray/cartouche/commit/ac2d6b74d96684dc4a577f6204c736f058bef1fb))


### Changed

* cut releases with release-please ([f894f1b](https://github.com/phmatray/cartouche/commit/f894f1b560963707c0f2fe63c53fde164279ad68))


### Documentation

* rewrite the README with a banner and screenshots ([59ceb1b](https://github.com/phmatray/cartouche/commit/59ceb1b684e288da300d70ce1e2b4eb30f866a25))

## [1.0.0] - 2026-09-26

First public release of Cartouche, an emulator for Game Boy and Game Boy
Color games that runs in the browser.

### Added

- Rust/WebAssembly emulation core: SM83 CPU, PPU (DMG and CGB), APU with four
  channels, timers, interrupts, serial link, MBC1/MBC2/MBC3/MBC5 cartridges,
  battery saves and save states.
- Library of free homebrew and your own ROMs (commercial games are never
  listed), recognized by hash with GameDataBase and libretro-database
  metadata; search, sort, favorites, region filter, bulk import that skips
  damaged files.
- Player: speed control, rewind, save-state slots, LCD shader presets,
  fullscreen, keyboard, gamepad and touch controls, debug drawer.
- Two-player link cable on one page.
- Tobu Tobu Girl (Tangram Games, MIT + CC BY 4.0) bundled so the app can be
  played offline right away.
- Optional box art for recognized ROMs you added, downloaded at runtime from
  libretro-thumbnails (Game Boy and Game Boy Color). Off by default: a
  first-launch "Show box art?" dialog asks before any request; covers are
  kept only in the browser, and Settings > Storage shows their size, deletes
  them and downloads them again.
- Legal notice (`/legal` and docs/LEGAL.md), third-party notices, takedown
  procedure, contribution and security policies. Every build ships
  `LICENSE.txt`, `THIRD_PARTY_NOTICES.txt` and `THIRD_PARTY_LICENSES.txt`.
- CI (tests against Blargg test ROMs, dmg/cgb-acid2, save-state round trips
  and smoke runs of ten freely licensed homebrew ROMs, nine in CGB mode),
  GitHub Pages deployment after green CI, and a release workflow that runs CI
  on the tag first.

### Test status

`cargo test --release --no-fail-fast` in `gb-core/`: 119 tests, 119 passed,
0 failed, 0 ignored (module tests 16, `blargg` 59, `acid2` 3, `cgb` 9,
`cpu_tests` 19, `homebrew` 10, `link` 3).

- Blargg: cpu_instrs, instr_timing, mem_timing, mem_timing-2, interrupt_time,
  halt_bug, dmg_sound and cgb_sound (all singles and combined ROMs) pass;
  oam_bug passes as the combined ROM (every subtest reports ok) and 7 of its
  8 singles run on their own. `oam_bug/rom_singles/7-timing_effect.gb` is
  not run on its own: it never reports a result
  because of a defect in the ROM: its text log (17 + 19 × 515 = 9802 bytes,
  about 9.8 KB) overruns the 8 KB of cartridge RAM its header declares,
  overwrites its own code at $C000, and the ROM keeps restarting. The same
  test code passes as subtest 07 of the combined `oam_bug.gb`, which checks a
  CRC of that output against the hardware value; the test suite covers
  test 7 that way.
- dmg-acid2 and cgb-acid2 match the reference images pixel for pixel.
- The ten homebrew smoke tests (nine in CGB mode) run 1,500 frames each
  without an emulator error or a frozen picture.

[1.0.0]: https://github.com/phmatray/cartouche/releases/tag/v1.0.0
