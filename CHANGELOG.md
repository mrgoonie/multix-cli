# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.26.0-beta](https://github.com/mrgoonie/multix-cli/compare/v1.25.0...v1.26.0-beta) (2026-10-31)


### Added

* **gemini:** add Lyria music generation and Lyria RealTime recording ([#532](https://github.com/mrgoonie/multix-cli/issues/532)) ([a045f03](https://github.com/mrgoonie/multix-cli/commit/a045f03effe903349559e174fb01ecadccb9d874)), closes [#527](https://github.com/mrgoonie/multix-cli/issues/527)


### Fixed

* **agent:** list files saved into an --output directory in outputs ([#543](https://github.com/mrgoonie/multix-cli/issues/543)) ([eff86cb](https://github.com/mrgoonie/multix-cli/commit/eff86cb339b024d4d9b4a222a2513c285e7403fb))
* **mcp:** gate remote gemini generate-music --model through the uncapped-spend policy ([#537](https://github.com/mrgoonie/multix-cli/issues/537)) ([92b824b](https://github.com/mrgoonie/multix-cli/commit/92b824b75ca5701afcef7a7e4091247dfa60b444)), closes [#536](https://github.com/mrgoonie/multix-cli/issues/536)
* **sume:** count a job's captured charge once per job, not per GET path ([#541](https://github.com/mrgoonie/multix-cli/issues/541)) ([40609be](https://github.com/mrgoonie/multix-cli/commit/40609be57495ccd698777c6d546051cd2ffaa710))
* **update:** read the running version from the root program ([#542](https://github.com/mrgoonie/multix-cli/issues/542)) ([f2d7f35](https://github.com/mrgoonie/multix-cli/commit/f2d7f35bb1e3b1c2c56cf714e33a48d5c00a39b9))

## [1.25.0](https://github.com/mrgoonie/multix-cli/compare/v1.24.0...v1.25.0) (2026-10-31)


### Added

* **mcp:** author skills with drafts, revisions and team sharing ([#451](https://github.com/mrgoonie/multix-cli/issues/451)) ([f96162b](https://github.com/mrgoonie/multix-cli/commit/f96162b608099961e978198359b2773f9ba8c7eb)), closes [#431](https://github.com/mrgoonie/multix-cli/issues/431)
* **mcp:** run skill workflows after explicit authorization ([#481](https://github.com/mrgoonie/multix-cli/issues/481)) ([fd646e9](https://github.com/mrgoonie/multix-cli/commit/fd646e9044c68cf855542ec1e9705dd2d8e0c7df)), closes [#432](https://github.com/mrgoonie/multix-cli/issues/432)
* **providers:** add Sume and TopView native providers ([#446](https://github.com/mrgoonie/multix-cli/issues/446)) ([9c7a73c](https://github.com/mrgoonie/multix-cli/commit/9c7a73c0ac2a977cccf72e53654828ef30510862)), closes [#413](https://github.com/mrgoonie/multix-cli/issues/413)


### Fixed

* **agent:** count a task's credits once across its submit and status runs ([#465](https://github.com/mrgoonie/multix-cli/issues/465)) ([095cff3](https://github.com/mrgoonie/multix-cli/commit/095cff34abb7b177cdca91db719a0ef89fc114ce)), closes [#424](https://github.com/mrgoonie/multix-cli/issues/424)
* **agent:** keep a run's job id after many uploads and name the job a fal result reads ([#490](https://github.com/mrgoonie/multix-cli/issues/490)) ([ca05c7b](https://github.com/mrgoonie/multix-cli/commit/ca05c7bd73f00359b2c23b0b3d96f05ba5571393))
* **agent:** name the job a status read was given so a failed read joins its operation ([#503](https://github.com/mrgoonie/multix-cli/issues/503)) ([c908fb7](https://github.com/mrgoonie/multix-cli/commit/c908fb7dd5c201c0b913bb92360e80efd9e5d965))
* **agent:** name the job in a receipt's default operation id ([#478](https://github.com/mrgoonie/multix-cli/issues/478)) ([fb9c77b](https://github.com/mrgoonie/multix-cli/commit/fb9c77bae9c20df910b0415f7cc824b0d60cf95c)), closes [#439](https://github.com/mrgoonie/multix-cli/issues/439)
* **agent:** record a file: URL write as its decoded OS path in --json outputs ([#523](https://github.com/mrgoonie/multix-cli/issues/523)) ([dd7dd81](https://github.com/mrgoonie/multix-cli/commit/dd7dd810eeeccd9d368863997aea7897296a282f))
* **agent:** report outputs written to an output dir inside the temp dir ([#507](https://github.com/mrgoonie/multix-cli/issues/507)) ([85b6957](https://github.com/mrgoonie/multix-cli/commit/85b695704a12d7a44a62f4212b5fe28092e0fbae))
* **agent:** resume an accepted job instead of offering a paid rerun after a failure ([#522](https://github.com/mrgoonie/multix-cli/issues/522)) ([bb477c9](https://github.com/mrgoonie/multix-cli/commit/bb477c9516438422817fc5b52821578115d86249)), closes [#501](https://github.com/mrgoonie/multix-cli/issues/501)
* **agent:** treat only ~/.multix itself as CLI state in --json outputs ([#512](https://github.com/mrgoonie/multix-cli/issues/512)) ([550475b](https://github.com/mrgoonie/multix-cli/commit/550475be32728ee798461c3ce08426a65d62a2f1))
* **byteplus:** send --audio as generate_audio, not the Seedance --wm watermark flag ([#472](https://github.com/mrgoonie/multix-cli/issues/472)) ([053a6f4](https://github.com/mrgoonie/multix-cli/commit/053a6f4b11279779b47a53122d2f3c0e1647fb84)), closes [#458](https://github.com/mrgoonie/multix-cli/issues/458)
* **byteplus:** throw when a succeeded task has no output URL instead of logging and exiting ([#517](https://github.com/mrgoonie/multix-cli/issues/517)) ([72db49d](https://github.com/mrgoonie/multix-cli/commit/72db49dbb726bafe806c157d4451b90a73437a86)), closes [#510](https://github.com/mrgoonie/multix-cli/issues/510)
* **catalog:** count a job the provider failed as failed, and classify provider job failures as JOB_FAILED ([#486](https://github.com/mrgoonie/multix-cli/issues/486)) ([4c78730](https://github.com/mrgoonie/multix-cli/commit/4c78730a014daef3226dd94e9778f4d010bc4389)), closes [#471](https://github.com/mrgoonie/multix-cli/issues/471) [#473](https://github.com/mrgoonie/multix-cli/issues/473)
* **catalog:** count a task's USD once when its status run lands in another row ([#482](https://github.com/mrgoonie/multix-cli/issues/482)) ([babc981](https://github.com/mrgoonie/multix-cli/commit/babc981cf551ff15684ad479d1dce65cba13a963))
* **catalog:** count usage outcomes per operation and skip runs that sent nothing ([#448](https://github.com/mrgoonie/multix-cli/issues/448)) ([f912aea](https://github.com/mrgoonie/multix-cli/commit/f912aea26dd39645d0ee4cdf113abb3f7aa5e1f3)), closes [#434](https://github.com/mrgoonie/multix-cli/issues/434)
* **catalog:** rank only confirmed list prices in compare and recommend ([#461](https://github.com/mrgoonie/multix-cli/issues/461)) ([074add9](https://github.com/mrgoonie/multix-cli/commit/074add97ce8a1aeea6374bffed0e014fd5caee10)), closes [#435](https://github.com/mrgoonie/multix-cli/issues/435)
* **catalog:** redact bare base64 keys and arrow, double-equals and quoted secret pairs in reviews ([#515](https://github.com/mrgoonie/multix-cli/issues/515)) ([1c17401](https://github.com/mrgoonie/multix-cli/commit/1c1740157ffd3fc789df7e14c20d112468bc26fc)), closes [#474](https://github.com/mrgoonie/multix-cli/issues/474)
* **catalog:** scrub secrets from reviews and verify review run references ([#488](https://github.com/mrgoonie/multix-cli/issues/488)) ([60afbdd](https://github.com/mrgoonie/multix-cli/commit/60afbdd76dd83421231cbdae826c690c014379ec)), closes [#436](https://github.com/mrgoonie/multix-cli/issues/436)
* **catalog:** treat catalog as a local command group without dry-run or cost flags ([#433](https://github.com/mrgoonie/multix-cli/issues/433)) ([b7dd761](https://github.com/mrgoonie/multix-cli/commit/b7dd761ce6416899c7d07e567196e2f302254771)), closes [#430](https://github.com/mrgoonie/multix-cli/issues/430)
* **errors:** classify TopView payment_required as quota and Gemini generate errors by their own class ([#491](https://github.com/mrgoonie/multix-cli/issues/491)) ([f583bde](https://github.com/mrgoonie/multix-cli/commit/f583bde575ea50b378f05130472f8d811ce4ea58))
* **errors:** let fal result and MiniMax image-to-image errors propagate ([#497](https://github.com/mrgoonie/multix-cli/issues/497)) ([c34d7de](https://github.com/mrgoonie/multix-cli/commit/c34d7ded464422b055477b22982bf68a96a9c635))
* **errors:** throw provider-failed and timed-out poll jobs instead of logging and exiting ([#511](https://github.com/mrgoonie/multix-cli/issues/511)) ([6c42af8](https://github.com/mrgoonie/multix-cli/commit/6c42af884a17c992258f0671f1179f866b797881))
* **fal:** keep the error class and Retry-After when fal run wraps a poll or result failure ([#502](https://github.com/mrgoonie/multix-cli/issues/502)) ([20d2888](https://github.com/mrgoonie/multix-cli/commit/20d288886f8915838531c773e53e1983d856d1f7)), closes [#495](https://github.com/mrgoonie/multix-cli/issues/495)
* **fal:** retry a transient result fetch and bound each poll request by the wait deadline ([#518](https://github.com/mrgoonie/multix-cli/issues/518)) ([f833ceb](https://github.com/mrgoonie/multix-cli/commit/f833cebe733f556280ea08c84d5e4d05f09fcb43))
* **fal:** wait out a rate-limited status poll in fal run instead of failing ([#513](https://github.com/mrgoonie/multix-cli/issues/513)) ([309c6d5](https://github.com/mrgoonie/multix-cli/commit/309c6d529fb443826fb5a4076cfe279ce2e03c70))
* **gemini:** report saved images and request only the rest when a later --num-images request fails ([#505](https://github.com/mrgoonie/multix-cli/issues/505)) ([4512fb5](https://github.com/mrgoonie/multix-cli/commit/4512fb5393e6d6c36febc4de1e5a47af8b93c098))
* **mcp:** accept only plain decimals of at least 1 for capped counts and durations ([#450](https://github.com/mrgoonie/multix-cli/issues/450)) ([f2f6fd7](https://github.com/mrgoonie/multix-cli/commit/f2f6fd78c666d5dc868676dcf4c3baf6776e1f61)), closes [#442](https://github.com/mrgoonie/multix-cli/issues/442)
* **mcp:** cap elevenlabs sfx and music lengths with MULTIX_MCP_MAX_AUDIO_SECONDS ([#459](https://github.com/mrgoonie/multix-cli/issues/459)) ([3701939](https://github.com/mrgoonie/multix-cli/commit/3701939fc71e91922f26171bfa96190fb605fabe)), closes [#449](https://github.com/mrgoonie/multix-cli/issues/449)
* **mcp:** classify the remaining spend gaps and test every catalog command ([#455](https://github.com/mrgoonie/multix-cli/issues/455)) ([4c19b0b](https://github.com/mrgoonie/multix-cli/commit/4c19b0b3b483da63ae0499fa7e9a81f2e47466b0))
* **mcp:** keep BytePlus prompt text from overriding the video caps ([#463](https://github.com/mrgoonie/multix-cli/issues/463)) ([aedc482](https://github.com/mrgoonie/multix-cli/commit/aedc482e95afb95cfa2a5c260cf8638887b2a8a7))
* **mcp:** let the operator limit the image models multix_run may use ([#467](https://github.com/mrgoonie/multix-cli/issues/467)) ([094fd8b](https://github.com/mrgoonie/multix-cli/commit/094fd8bcf526c6f0842fdffaee04b71e239ec232)), closes [#452](https://github.com/mrgoonie/multix-cli/issues/452)
* **mcp:** refuse leonardo video when the video length cap is below what it renders ([#462](https://github.com/mrgoonie/multix-cli/issues/462)) ([7402491](https://github.com/mrgoonie/multix-cli/commit/740249185d1857b8b67b1ee204b0dea78a7db8dc))
* **mcp:** refuse runs the operator spend caps cannot bound unless a budget proves them ([#441](https://github.com/mrgoonie/multix-cli/issues/441)) ([8ea79d8](https://github.com/mrgoonie/multix-cli/commit/8ea79d8d47e296743829ea407d3f986e9d1d3f0d)), closes [#425](https://github.com/mrgoonie/multix-cli/issues/425)
* **mcp:** treat image size, quality and tier options as uncapped spend in multix_run ([#453](https://github.com/mrgoonie/multix-cli/issues/453)) ([750752d](https://github.com/mrgoonie/multix-cli/commit/750752da690c42363b32ca0d67edb7363c955864))
* **openrouter:** stop waiting on a cancelled or expired video job ([#516](https://github.com/mrgoonie/multix-cli/issues/516)) ([961f5b4](https://github.com/mrgoonie/multix-cli/commit/961f5b46bf4b6cdb009b03aa20fc96b3ea5fe146)), closes [#509](https://github.com/mrgoonie/multix-cli/issues/509)
* **site:** list Sume and TopView on the landing page ([3875570](https://github.com/mrgoonie/multix-cli/commit/3875570cd29b746ac344df346f26eaf1e66c1666))


### Performance

* **catalog:** group a usage operation's runs in place ([#484](https://github.com/mrgoonie/multix-cli/issues/484)) ([6b8344b](https://github.com/mrgoonie/multix-cli/commit/6b8344b62ba2fd7fad76650c6c6ab731a060f6c0)), closes [#445](https://github.com/mrgoonie/multix-cli/issues/445)


### Changed

* **agent:** derive the history, provider and dry-run group lists from one list of tooling groups ([#440](https://github.com/mrgoonie/multix-cli/issues/440)) ([0ea402f](https://github.com/mrgoonie/multix-cli/commit/0ea402f6349319f6cbadfd1554edc8f4cbfda5ba)), closes [#438](https://github.com/mrgoonie/multix-cli/issues/438)


### Documentation

* **agents:** require a documentation impact check for every change ([#487](https://github.com/mrgoonie/multix-cli/issues/487)) ([1fd21c0](https://github.com/mrgoonie/multix-cli/commit/1fd21c03ca93c855e125a24a0e20afdfe3017879)), closes [#485](https://github.com/mrgoonie/multix-cli/issues/485)
* **mcp:** say sume video --duration is neither capped nor filled ([#470](https://github.com/mrgoonie/multix-cli/issues/470)) ([6c67eeb](https://github.com/mrgoonie/multix-cli/commit/6c67eebdc4e7d6f4e07e568a6f237a7ddb7a5a93))

## [1.24.0](https://github.com/mrgoonie/multix-cli/compare/v1.23.0...v1.24.0) (2026-10-28)


### Added

* **site:** obsidian redesign of the site and MCP dashboard ([#412](https://github.com/mrgoonie/multix-cli/issues/412)) ([3c1f85d](https://github.com/mrgoonie/multix-cli/commit/3c1f85d89845d49c6eec9b8286c39928e2603884))

## [1.23.0](https://github.com/mrgoonie/multix-cli/compare/v1.22.0...v1.23.0) (2026-10-28)


### Added

* **agent:** record requested vs resolved model and job identity in receipts ([#394](https://github.com/mrgoonie/multix-cli/issues/394)) ([1bad7f4](https://github.com/mrgoonie/multix-cli/commit/1bad7f45cbd9fbafcdf5213d78a4ebaac42254f8)), closes [#389](https://github.com/mrgoonie/multix-cli/issues/389)
* **fal:** check tts dialogue and --input fields before submit, refuse sample-less WAV ([#370](https://github.com/mrgoonie/multix-cli/issues/370)) ([5afbd26](https://github.com/mrgoonie/multix-cli/commit/5afbd26cae374d124f03b64626c821cb539893b8))
* **media:** offline media inspect, verify, frames and receipts ([#373](https://github.com/mrgoonie/multix-cli/issues/373)) ([2ca8047](https://github.com/mrgoonie/multix-cli/commit/2ca8047886e2d958d8cb961a5416e9b288ebeaed))
* **speech:** route OpenRouter and fal TTS through multix speech ([#372](https://github.com/mrgoonie/multix-cli/issues/372)) ([ad2a41f](https://github.com/mrgoonie/multix-cli/commit/ad2a41f366c80950d87a033ed6bbad3863e377cc)), closes [#334](https://github.com/mrgoonie/multix-cli/issues/334)


### Fixed

* **agent:** count a request cut off by a signal in the cost receipt ([#395](https://github.com/mrgoonie/multix-cli/issues/395)) ([980f4c7](https://github.com/mrgoonie/multix-cli/commit/980f4c70afe6953732f43a82e3f25f020e9ab3a6)), closes [#388](https://github.com/mrgoonie/multix-cli/issues/388)
* **agent:** report a signal-cancelled run as CANCELLED with its real exit code ([#379](https://github.com/mrgoonie/multix-cli/issues/379)) ([1ba0b4a](https://github.com/mrgoonie/multix-cli/commit/1ba0b4a139635c44e7bf53761a67411d78874b4d))
* **atlas:** report a signal during the schema fetch as a clean cancel ([#402](https://github.com/mrgoonie/multix-cli/issues/402)) ([9ebbf20](https://github.com/mrgoonie/multix-cli/commit/9ebbf207244a456d1b2b0c9929990d65f50c0879)), closes [#392](https://github.com/mrgoonie/multix-cli/issues/392)
* **atlas:** report signals during submit, uploads and status --wait ([#391](https://github.com/mrgoonie/multix-cli/issues/391)) ([3c06554](https://github.com/mrgoonie/multix-cli/commit/3c06554f6282e6d40635bdc01347b59c37bac108)), closes [#388](https://github.com/mrgoonie/multix-cli/issues/388)
* **atlas:** report the prediction id and resume command when a signal stops the wait ([#386](https://github.com/mrgoonie/multix-cli/issues/386)) ([0cbd52f](https://github.com/mrgoonie/multix-cli/commit/0cbd52f9a0c3262f46df3db0e105daea7b15e9c5))
* **media:** a second signal no longer reports a clean CANCELLED after skipping cleanup ([#390](https://github.com/mrgoonie/multix-cli/issues/390)) ([69cc2ee](https://github.com/mrgoonie/multix-cli/commit/69cc2ee649a1d64c05208d5ec465273da76a3fba)), closes [#385](https://github.com/mrgoonie/multix-cli/issues/385)
* **media:** fail media verify on a WAV cut short of its declared data size ([#380](https://github.com/mrgoonie/multix-cli/issues/380)) ([6c1b8e9](https://github.com/mrgoonie/multix-cli/commit/6c1b8e90d9f17d96f981a60e279d6b7dd5f8d1fc)), closes [#374](https://github.com/mrgoonie/multix-cli/issues/374)
* **media:** pass piped WAVs and cover a cut WAV by its declared duration ([#382](https://github.com/mrgoonie/multix-cli/issues/382)) ([67b5273](https://github.com/mrgoonie/multix-cli/commit/67b5273eca07493516341c9f32cfd5cefdc81367))
* **media:** refuse a URL in media verify before checking for ffmpeg ([#409](https://github.com/mrgoonie/multix-cli/issues/409)) ([7e9289f](https://github.com/mrgoonie/multix-cli/commit/7e9289f3bc3ae545373e4fd24372eb22e8013a37)), closes [#408](https://github.com/mrgoonie/multix-cli/issues/408)
* **media:** report the verify engine of a receipt in check-receipt ([#387](https://github.com/mrgoonie/multix-cli/issues/387)) ([ba94ac9](https://github.com/mrgoonie/multix-cli/commit/ba94ac995c91d54635aca7e7cde0e9fbe0cb1044)), closes [#381](https://github.com/mrgoonie/multix-cli/issues/381)

## [1.22.0](https://github.com/mrgoonie/multix-cli/compare/v1.21.1...v1.22.0) (2026-10-27)


### Added

* **budget:** price speech generate on its gemini and elevenlabs routes ([764f2fa](https://github.com/mrgoonie/multix-cli/commit/764f2fa3e7f26312f56979449affb7f10c07d530))
* **budget:** price speech generate on its gemini and elevenlabs routes ([0bbd998](https://github.com/mrgoonie/multix-cli/commit/0bbd9983c0c717a04363475c92d8c0a4ca5930c4)), closes [#344](https://github.com/mrgoonie/multix-cli/issues/344)
* **budget:** price speech generate on its gemini and elevenlabs routes ([#355](https://github.com/mrgoonie/multix-cli/issues/355)) ([764f2fa](https://github.com/mrgoonie/multix-cli/commit/764f2fa3e7f26312f56979449affb7f10c07d530))
* **fish:** add native Fish Audio TTS with Drama 3, multi-speaker and dictionaries ([c955217](https://github.com/mrgoonie/multix-cli/commit/c9552173963d5bcef83c19ae17db5bb1124809f4)), closes [#357](https://github.com/mrgoonie/multix-cli/issues/357)
* **fish:** add voice design, voice cloning and voice deletion ([#360](https://github.com/mrgoonie/multix-cli/issues/360)) ([c3cc2fb](https://github.com/mrgoonie/multix-cli/commit/c3cc2fbe13d7e61c116704eab2c36f8b19635035))


### Fixed

* **agent:** do not drop spend keys like *_credits_used as balances ([#343](https://github.com/mrgoonie/multix-cli/issues/343)) ([da269f5](https://github.com/mrgoonie/multix-cli/commit/da269f57a80114caf88bfeb0479fd18d6166d780))
* **budget:** speak the priced --text-file and bound fallback ranges per route ([1c95848](https://github.com/mrgoonie/multix-cli/commit/1c958480a51d4ac9c4f4db84da92a94e8450eab6)), closes [#344](https://github.com/mrgoonie/multix-cli/issues/344)
* **openrouter:** price Fish Audio TTS models per UTF-8 byte ([6a96c42](https://github.com/mrgoonie/multix-cli/commit/6a96c427f36d5adaa5b4262637571311bdf969e0)), closes [#357](https://github.com/mrgoonie/multix-cli/issues/357)
* **scene:** give bare punctuation and tags words to go with when splitting ([d6e8d86](https://github.com/mrgoonie/multix-cli/commit/d6e8d86e61103f96d87cd2ff3673ca72855ebac5)), closes [#347](https://github.com/mrgoonie/multix-cli/issues/347)
* **scene:** keep tags with spoken text in unspaced lines and join bare parts ([3977bac](https://github.com/mrgoonie/multix-cli/commit/3977bace972480605a536c83d9cc50b8ee822158)), closes [#347](https://github.com/mrgoonie/multix-cli/issues/347)
* **scene:** move the last spoken word, not a trailing "?" or tag, into a bare part ([f60c46c](https://github.com/mrgoonie/multix-cli/commit/f60c46c4a49cc53d25dd1aecdf7bff178704da36))
* **scene:** never send a markup tag as its own part when splitting a line ([6932a54](https://github.com/mrgoonie/multix-cli/commit/6932a54b9e0140739c059d26be9d980e63f624ba)), closes [#347](https://github.com/mrgoonie/multix-cli/issues/347)
* **scene:** never send a markup tag as its own part when splitting a long line ([9aae371](https://github.com/mrgoonie/multix-cli/commit/9aae3719406aea790bdc92b740633848d7041eb5))
* **scene:** never send a markup tag as its own part when splitting a long line ([#354](https://github.com/mrgoonie/multix-cli/issues/354)) ([9aae371](https://github.com/mrgoonie/multix-cli/commit/9aae3719406aea790bdc92b740633848d7041eb5))

## [1.21.1](https://github.com/mrgoonie/multix-cli/compare/v1.21.0...v1.21.1) (2026-10-26)


### Fixed

* **models:** do not confirm models from a cache older than the TTL ceiling when offline ([#352](https://github.com/mrgoonie/multix-cli/issues/352)) ([4438372](https://github.com/mrgoonie/multix-cli/commit/4438372199bb9b8bad950d4f9a16b36d8d5e89ba)), closes [#349](https://github.com/mrgoonie/multix-cli/issues/349)

## [1.21.0](https://github.com/mrgoonie/multix-cli/compare/v1.20.0...v1.21.0) (2026-10-26)


### Added

* **scene:** character voice profiles, scene manifests and selective take rendering ([#320](https://github.com/mrgoonie/multix-cli/issues/320)) ([0abb1ff](https://github.com/mrgoonie/multix-cli/commit/0abb1fffe55118c47e06cffce4086189a70f13af))

## [1.20.0](https://github.com/mrgoonie/multix-cli/compare/v1.19.0...v1.20.0) (2026-10-26)


### Added

* **models:** truthful, task-aware capability registry for CLI and MCP agents ([#317](https://github.com/mrgoonie/multix-cli/issues/317)) ([635f2e6](https://github.com/mrgoonie/multix-cli/commit/635f2e69ba1aacfbfd5f8f94f2e93447d263864a)), closes [#293](https://github.com/mrgoonie/multix-cli/issues/293)

## [1.19.0](https://github.com/mrgoonie/multix-cli/compare/v1.18.2...v1.19.0) (2026-10-26)


### Added

* **openrouter:** add speech-to-text via /audio/transcriptions ([#328](https://github.com/mrgoonie/multix-cli/issues/328)) ([795c756](https://github.com/mrgoonie/multix-cli/commit/795c7564ffa3cdc968089f3f40dae5e1aadbab14))

## [1.18.2](https://github.com/mrgoonie/multix-cli/compare/v1.18.1...v1.18.2) (2026-10-26)


### Fixed

* **agent:** never report an account credit balance as credits spent ([#306](https://github.com/mrgoonie/multix-cli/issues/306)) ([218e57a](https://github.com/mrgoonie/multix-cli/commit/218e57a12e29e4e265c8a7548aa83019166ea850))

## [1.18.1](https://github.com/mrgoonie/multix-cli/compare/v1.18.0...v1.18.1) (2026-10-26)


### Fixed

* **elevenlabs:** warn on SSML &lt;phoneme&gt; only for models that drop the word ([#331](https://github.com/mrgoonie/multix-cli/issues/331)) ([60505f4](https://github.com/mrgoonie/multix-cli/commit/60505f4140283578b0ab5779eb41b84b9e1d5cf4)), closes [#323](https://github.com/mrgoonie/multix-cli/issues/323)

## [1.18.0](https://github.com/mrgoonie/multix-cli/compare/v1.17.1...v1.18.0) (2026-10-26)


### Added

* **budget:** price estimates, spend guards and reconciled cost receipts ([#327](https://github.com/mrgoonie/multix-cli/issues/327)) ([1a1e1b3](https://github.com/mrgoonie/multix-cli/commit/1a1e1b3d38101f936f125859ec7e86113b003c16)), closes [#295](https://github.com/mrgoonie/multix-cli/issues/295)

## [1.17.1](https://github.com/mrgoonie/multix-cli/compare/v1.17.0...v1.17.1) (2026-10-26)


### Fixed

* **agent:** redact URL query strings in dry-run request bodies ([#326](https://github.com/mrgoonie/multix-cli/issues/326)) ([791e612](https://github.com/mrgoonie/multix-cli/commit/791e6120cc984d762bcc4e5673d419eb686391d0)), closes [#318](https://github.com/mrgoonie/multix-cli/issues/318)

## [1.17.0](https://github.com/mrgoonie/multix-cli/compare/v1.16.0...v1.17.0) (2026-10-26)


### Added

* **elevenlabs:** add --clone-strength and stricter TTS input checks ([#319](https://github.com/mrgoonie/multix-cli/issues/319)) ([aa9cbdf](https://github.com/mrgoonie/multix-cli/commit/aa9cbdf3f61c83dc0b782e49198ae51940e06b5e))


### Fixed

* **gemini:** state edit/extend intent on Omni follow-up turns ([#276](https://github.com/mrgoonie/multix-cli/issues/276)) ([7058c46](https://github.com/mrgoonie/multix-cli/commit/7058c46e8fdb9cc49fd2605278464531f834e009))

## [1.16.0](https://github.com/mrgoonie/multix-cli/compare/v1.15.0...v1.16.0) (2026-10-26)


### Added

* **openrouter:** add text-to-speech via /audio/speech ([#313](https://github.com/mrgoonie/multix-cli/issues/313)) ([18dd61b](https://github.com/mrgoonie/multix-cli/commit/18dd61b17ccdbb82b481cc53ff6cfa5ed0912ebe)), closes [#290](https://github.com/mrgoonie/multix-cli/issues/290)

## [1.15.0](https://github.com/mrgoonie/multix-cli/compare/v1.14.1...v1.15.0) (2026-10-26)


### Added

* **elevenlabs:** support v4 and v4 Turbo TTS with model-specific controls ([#308](https://github.com/mrgoonie/multix-cli/issues/308)) ([0e5ca9c](https://github.com/mrgoonie/multix-cli/commit/0e5ca9cee17d29d7e25189ef8d2c758347036fd8)), closes [#292](https://github.com/mrgoonie/multix-cli/issues/292)
* **fal:** typed text-to-speech with verified audio output ([#305](https://github.com/mrgoonie/multix-cli/issues/305)) ([26c69b0](https://github.com/mrgoonie/multix-cli/commit/26c69b0b5b972a5201e878b0c200a848c0478c9f)), closes [#291](https://github.com/mrgoonie/multix-cli/issues/291)

## [1.14.1](https://github.com/mrgoonie/multix-cli/compare/v1.14.0...v1.14.1) (2026-10-26)


### Fixed

* **agent:** never report a provider's estimated cost as credits or cost spent ([#301](https://github.com/mrgoonie/multix-cli/issues/301)) ([f8b98ef](https://github.com/mrgoonie/multix-cli/commit/f8b98ef6ee5201b5f02f5ded930ce4a87f19ae17)), closes [#298](https://github.com/mrgoonie/multix-cli/issues/298)

## [1.14.0](https://github.com/mrgoonie/multix-cli/compare/v1.13.0...v1.14.0) (2026-10-25)


### Added

* **fal:** local media upload and detached queue jobs with durable receipts ([#286](https://github.com/mrgoonie/multix-cli/issues/286)) ([41f7d1b](https://github.com/mrgoonie/multix-cli/commit/41f7d1bc63fb8c6df2ea7482a3b6a6e320e36a02)), closes [#284](https://github.com/mrgoonie/multix-cli/issues/284) [#285](https://github.com/mrgoonie/multix-cli/issues/285)

## [1.13.0](https://github.com/mrgoonie/multix-cli/compare/v1.12.5...v1.13.0) (2026-10-21)


### Added

* **cli:** agent mode with JSON envelope, error classes, dry run, run history and model discovery ([#282](https://github.com/mrgoonie/multix-cli/issues/282)) ([bfd7e60](https://github.com/mrgoonie/multix-cli/commit/bfd7e6024a546967f41dd4416d4853e061048eb2)), closes [#277](https://github.com/mrgoonie/multix-cli/issues/277)

## [1.12.5](https://github.com/mrgoonie/multix-cli/compare/v1.12.4...v1.12.5) (2026-10-21)


### Fixed

* **replicate:** trust Replicate's R2 output host and retry transient download errors ([#279](https://github.com/mrgoonie/multix-cli/issues/279)) ([b68a769](https://github.com/mrgoonie/multix-cli/commit/b68a7699181b51d316be84cdccabd4bb82705f45))

## [1.12.4](https://github.com/mrgoonie/multix-cli/compare/v1.12.3...v1.12.4) (2026-10-20)


### Fixed

* **gemini:** bound Omni inline video bodies and make --wait-timeout an overall deadline ([#274](https://github.com/mrgoonie/multix-cli/issues/274)) ([5d3910f](https://github.com/mrgoonie/multix-cli/commit/5d3910fe87818cbba7e17a927ae5b65b2390a9ea)), closes [#256](https://github.com/mrgoonie/multix-cli/issues/256)
* **worker:** force Gemini Omni Flash for remote edit-video and extend-video ([#273](https://github.com/mrgoonie/multix-cli/issues/273)) ([10ddfea](https://github.com/mrgoonie/multix-cli/commit/10ddfead2a7735c56fa058895b3139f128b84362))

## [1.12.3](https://github.com/mrgoonie/multix-cli/compare/v1.12.2...v1.12.3) (2026-10-20)


### Fixed

* **gemini:** send the API key only to Files API paths in Veo downloads ([#263](https://github.com/mrgoonie/multix-cli/issues/263)) ([4aa1d31](https://github.com/mrgoonie/multix-cli/commit/4aa1d310b2e3dc084a9f7a09448f7690cc21f93d)), closes [#259](https://github.com/mrgoonie/multix-cli/issues/259) [#268](https://github.com/mrgoonie/multix-cli/issues/268)

## [1.12.2](https://github.com/mrgoonie/multix-cli/compare/v1.12.1...v1.12.2) (2026-10-20)


### Documentation

* **worker:** state that the video cap bounds each Gemini extend, not a chain ([#266](https://github.com/mrgoonie/multix-cli/issues/266)) ([45088cb](https://github.com/mrgoonie/multix-cli/commit/45088cb8f0e645568a2db9420045ef9c1d63bbd9))

## [1.12.1](https://github.com/mrgoonie/multix-cli/compare/v1.12.0...v1.12.1) (2026-10-20)


### Fixed

* **core:** add a random suffix to timestamp-based output file names ([#265](https://github.com/mrgoonie/multix-cli/issues/265)) ([a662f3a](https://github.com/mrgoonie/multix-cli/commit/a662f3a33d655974ce0362d513076931d5a79e8d)), closes [#260](https://github.com/mrgoonie/multix-cli/issues/260)

## [1.12.0](https://github.com/mrgoonie/multix-cli/compare/v1.11.0...v1.12.0) (2026-10-20)


### Added

* **gemini:** default video to Gemini Omni Flash and add edit, extend, status and cancel ([#261](https://github.com/mrgoonie/multix-cli/issues/261)) ([7459bda](https://github.com/mrgoonie/multix-cli/commit/7459bda232ebff675e1bd5acf375d6887614f6e9)), closes [#254](https://github.com/mrgoonie/multix-cli/issues/254) [#255](https://github.com/mrgoonie/multix-cli/issues/255)

## [1.11.0](https://github.com/mrgoonie/multix-cli/compare/v1.10.5...v1.11.0) (2026-10-17)


### Added

* **runway:** offline models listing and JSON-only status stdout ([#248](https://github.com/mrgoonie/multix-cli/issues/248)) ([67e4915](https://github.com/mrgoonie/multix-cli/commit/67e49159650ee068af7e1fefd2deb7fe8c7560d8)), closes [#242](https://github.com/mrgoonie/multix-cli/issues/242)

## [1.10.5](https://github.com/mrgoonie/multix-cli/compare/v1.10.4...v1.10.5) (2026-10-17)


### Fixed

* **worker:** re-check webhook callback addresses at subscribe and before each delivery ([#246](https://github.com/mrgoonie/multix-cli/issues/246)) ([0725be1](https://github.com/mrgoonie/multix-cli/commit/0725be1a69a9082a082845ba82ffa7cd0d3d8df4)), closes [#226](https://github.com/mrgoonie/multix-cli/issues/226)

## [1.10.4](https://github.com/mrgoonie/multix-cli/compare/v1.10.3...v1.10.4) (2026-10-17)


### Documentation

* **site:** list the MCP, REST API and troubleshooting pages in llms.txt ([#244](https://github.com/mrgoonie/multix-cli/issues/244)) ([69ae416](https://github.com/mrgoonie/multix-cli/commit/69ae41656f96d4d2199acf23d1f6e432d2b69444)), closes [#241](https://github.com/mrgoonie/multix-cli/issues/241)

## [1.10.3](https://github.com/mrgoonie/multix-cli/compare/v1.10.2...v1.10.3) (2026-10-17)


### Documentation

* **site:** list fal.ai, Atlas Cloud, Replicate and Runway in llms.txt ([#240](https://github.com/mrgoonie/multix-cli/issues/240)) ([68ec0ae](https://github.com/mrgoonie/multix-cli/commit/68ec0ae4382298693dcce834d0ffe5d12b939afa)), closes [#230](https://github.com/mrgoonie/multix-cli/issues/230)

## [1.10.2](https://github.com/mrgoonie/multix-cli/compare/v1.10.1...v1.10.2) (2026-10-15)


### Fixed

* **runway:** refuse non-media downloads, credentialed URLs and echoed secrets ([#238](https://github.com/mrgoonie/multix-cli/issues/238)) ([3e460b9](https://github.com/mrgoonie/multix-cli/commit/3e460b919fd7e816b4ffb22baa0c4b4d89b303da)), closes [#235](https://github.com/mrgoonie/multix-cli/issues/235)

## [1.10.1](https://github.com/mrgoonie/multix-cli/compare/v1.10.0...v1.10.1) (2026-10-15)


### Fixed

* **images:** reject an invalid image format before the paid request ([#236](https://github.com/mrgoonie/multix-cli/issues/236)) ([18b7668](https://github.com/mrgoonie/multix-cli/commit/18b7668df371d8321a291c58c88a703a357808bb))

## [1.10.0](https://github.com/mrgoonie/multix-cli/compare/v1.9.0...v1.10.0) (2026-10-15)


### Added

* **runway:** add native Runway provider for video, image and async tasks ([#231](https://github.com/mrgoonie/multix-cli/issues/231)) ([14cf24a](https://github.com/mrgoonie/multix-cli/commit/14cf24ad039a72c39dfd790bd62b07f729c1af62)), closes [#229](https://github.com/mrgoonie/multix-cli/issues/229)

## [1.9.0](https://github.com/mrgoonie/multix-cli/compare/v1.8.0...v1.9.0) (2026-10-15)


### Added

* **mcp:** serve MCP 2026-07-28 and MCP Events subscriptions ([#227](https://github.com/mrgoonie/multix-cli/issues/227)) ([daf12fd](https://github.com/mrgoonie/multix-cli/commit/daf12fd3cd00fbbe789ab33894bb9fbfe9fe68f9)), closes [#222](https://github.com/mrgoonie/multix-cli/issues/222)

## [1.8.0](https://github.com/mrgoonie/multix-cli/compare/v1.7.0...v1.8.0) (2026-10-15)


### Added

* **mcp:** deliver signed job completion and failure webhooks ([#224](https://github.com/mrgoonie/multix-cli/issues/224)) ([29db453](https://github.com/mrgoonie/multix-cli/commit/29db4535cda4be9a01dff8e213857e845497ce21)), closes [#223](https://github.com/mrgoonie/multix-cli/issues/223)

## [1.7.0](https://github.com/mrgoonie/multix-cli/compare/v1.6.2...v1.7.0) (2026-10-14)


### Added

* **mcp:** choose the R2 directory path for job outputs ([#212](https://github.com/mrgoonie/multix-cli/issues/212)) ([d363f7b](https://github.com/mrgoonie/multix-cli/commit/d363f7b5ddf2269bb705ee14decf0e023f7e7c3e))

## [1.6.2](https://github.com/mrgoonie/multix-cli/compare/v1.6.1...v1.6.2) (2026-10-14)


### Fixed

* **mcp:** route dashboard, MCP and health URLs with a query string to the Worker ([#210](https://github.com/mrgoonie/multix-cli/issues/210)) ([d5666f3](https://github.com/mrgoonie/multix-cli/commit/d5666f35e033b6ee84b30be9e7830f3466e9bce9))

## [1.6.1](https://github.com/mrgoonie/multix-cli/compare/v1.6.0...v1.6.1) (2026-10-14)


### Fixed

* **mcp:** retry a failed job slot release instead of waiting for the lease ([#204](https://github.com/mrgoonie/multix-cli/issues/204)) ([a0e25da](https://github.com/mrgoonie/multix-cli/commit/a0e25da028cf2e0ebecc09028f514c8f1f0fd2a2))

## [1.6.0](https://github.com/mrgoonie/multix-cli/compare/v1.5.0...v1.6.0) (2026-10-14)


### Added

* **mcp:** copy buttons for the API key, MCP URL and API doc examples ([#203](https://github.com/mrgoonie/multix-cli/issues/203)) ([6a6e1e0](https://github.com/mrgoonie/multix-cli/commit/6a6e1e021cb7d27e86422b4d6bac09fe1d4ddc60))

## [1.5.0](https://github.com/mrgoonie/multix-cli/compare/v1.4.0...v1.5.0) (2026-10-14)


### Added

* **mcp:** REST API with account API keys and API docs ([#200](https://github.com/mrgoonie/multix-cli/issues/200)) ([d4ee172](https://github.com/mrgoonie/multix-cli/commit/d4ee17295de8e06d9e7693b28abd5f5bb1ef854e))

## [1.4.0](https://github.com/mrgoonie/multix-cli/compare/v1.3.0...v1.4.0) (2026-10-14)


### Added

* **mcp:** make job concurrency caps configurable and drop the legacy provider tools ([#197](https://github.com/mrgoonie/multix-cli/issues/197)) ([c5ad73b](https://github.com/mrgoonie/multix-cli/commit/c5ad73b0da79040f05ba719898b235267671ddfe))

## [1.3.0](https://github.com/mrgoonie/multix-cli/compare/v1.2.3...v1.3.0) (2026-10-13)


### Added

* **mcp:** run multix-cli commands in Cloudflare Containers behind a few meta tools ([#178](https://github.com/mrgoonie/multix-cli/issues/178)) ([23b4bf9](https://github.com/mrgoonie/multix-cli/commit/23b4bf9704afea79d8826015b805d980218164cc))

## [1.2.3](https://github.com/mrgoonie/multix-cli/compare/v1.2.2...v1.2.3) (2026-10-13)


### Fixed

* **media:** show the cause of an ffmpeg failure instead of its banner ([#187](https://github.com/mrgoonie/multix-cli/issues/187)) ([5c10e08](https://github.com/mrgoonie/multix-cli/commit/5c10e087303cfd400b4efdc02ee5e6a7742aa02e))

## [1.2.2](https://github.com/mrgoonie/multix-cli/compare/v1.2.1...v1.2.2) (2026-10-13)


### Fixed

* **media:** drop cover art and keep mp4/mka/mkv/mov audio outputs ([#185](https://github.com/mrgoonie/multix-cli/issues/185)) ([7356d92](https://github.com/mrgoonie/multix-cli/commit/7356d921f5fc96e1ac61d6e68aabaaeffa6dbf51))

## [1.2.1](https://github.com/mrgoonie/multix-cli/compare/v1.2.0...v1.2.1) (2026-10-13)


### Fixed

* **media:** pick the audio codec from the output extension ([#180](https://github.com/mrgoonie/multix-cli/issues/180)) ([8f85ca4](https://github.com/mrgoonie/multix-cli/commit/8f85ca4633e3ed5d213acb566c59b77fb39a8666)), closes [#179](https://github.com/mrgoonie/multix-cli/issues/179)

## [1.2.0](https://github.com/mrgoonie/multix-cli/compare/v1.1.1...v1.2.0) (2026-10-13)


### Added

* **mcp:** dashboard inputs for every provider key and per-account R2 storage ([#175](https://github.com/mrgoonie/multix-cli/issues/175)) ([adfedda](https://github.com/mrgoonie/multix-cli/commit/adfeddaf2eeed6bb9eefdcf3ebe0c85dc3e5afd6))

## [1.1.1](https://github.com/mrgoonie/multix-cli/compare/v1.1.0...v1.1.1) (2026-10-13)


### Fixed

* **openai:** remove the Codex image driver's temp directory after each run ([#169](https://github.com/mrgoonie/multix-cli/issues/169)) ([88142d3](https://github.com/mrgoonie/multix-cli/commit/88142d3035dcb6a7923f232c5b8b700be9be8ecd)), closes [#164](https://github.com/mrgoonie/multix-cli/issues/164)

## [1.1.0](https://github.com/mrgoonie/multix-cli/compare/v1.0.12...v1.1.0) (2026-10-13)


### Added

* **mcp:** OAuth sign-in and per-account provider keys dashboard ([#152](https://github.com/mrgoonie/multix-cli/issues/152)) ([d51e4a7](https://github.com/mrgoonie/multix-cli/commit/d51e4a715606bb00eaa638e1e04e6357e4220008))

## [1.0.12](https://github.com/mrgoonie/multix-cli/compare/v1.0.11...v1.0.12) (2026-10-12)


### Fixed

* **mcp:** check Atlas template presets that name a resolution ([#145](https://github.com/mrgoonie/multix-cli/issues/145)) ([5d7127d](https://github.com/mrgoonie/multix-cli/commit/5d7127d930a164f568b099615078065c9f587719))

## [1.0.11](https://github.com/mrgoonie/multix-cli/compare/v1.0.10...v1.0.11) (2026-10-12)


### Fixed

* **mcp:** check all Atlas video resolution fields against the allowlist ([#142](https://github.com/mrgoonie/multix-cli/issues/142)) ([ec44d9e](https://github.com/mrgoonie/multix-cli/commit/ec44d9e7efa074704bb00b02735357a30c6ad2ac))

## [1.0.10](https://github.com/mrgoonie/multix-cli/compare/v1.0.9...v1.0.10) (2026-10-12)


### Fixed

* **mcp:** pin Atlas video price multipliers to their cheapest values ([#139](https://github.com/mrgoonie/multix-cli/issues/139)) ([5423c03](https://github.com/mrgoonie/multix-cli/commit/5423c03f64912180ac89e80339472938d18bb8dd))

## [1.0.9](https://github.com/mrgoonie/multix-cli/compare/v1.0.8...v1.0.9) (2026-10-11)


### Fixed

* **build:** ship the programmatic entry point declared in package.json ([#132](https://github.com/mrgoonie/multix-cli/issues/132)) ([1c41397](https://github.com/mrgoonie/multix-cli/commit/1c41397c0b8fda141311fef0fbc5c278b660a67f))

## [1.0.8](https://github.com/mrgoonie/multix-cli/compare/v1.0.7...v1.0.8) (2026-10-11)


### Fixed

* **mcp:** tighten Worker duration/resolution defaults and Cloudflare video errors ([#120](https://github.com/mrgoonie/multix-cli/issues/120)) ([e082feb](https://github.com/mrgoonie/multix-cli/commit/e082feb3c1b3d0b88c96aa0a837b903759d6db00))

## [1.0.7](https://github.com/mrgoonie/multix-cli/compare/v1.0.6...v1.0.7) (2026-10-11)


### Fixed

* **core:** let a later .env file fill a blank value ([#129](https://github.com/mrgoonie/multix-cli/issues/129)) ([bdfb673](https://github.com/mrgoonie/multix-cli/commit/bdfb6739770f0e7bb9d2623606cdb32d454779d4))

## [1.0.6](https://github.com/mrgoonie/multix-cli/compare/v1.0.5...v1.0.6) (2026-10-11)


### Fixed

* **providers:** read model defaults after loading .env files ([#121](https://github.com/mrgoonie/multix-cli/issues/121)) ([5f36dba](https://github.com/mrgoonie/multix-cli/commit/5f36dba0fc7a1ccbe3d904e928c4ef82b3c6ce36))

## [1.0.5](https://github.com/mrgoonie/multix-cli/compare/v1.0.4...v1.0.5) (2026-10-11)


### Fixed

* **core:** only load multix settings from a project .env ([#116](https://github.com/mrgoonie/multix-cli/issues/116)) ([896c0c0](https://github.com/mrgoonie/multix-cli/commit/896c0c00caf46ac46593f67f9a75508a4ac404cd))

## [1.0.4](https://github.com/mrgoonie/multix-cli/compare/v1.0.3...v1.0.4) (2026-10-11)


### Fixed

* **core:** do not retry deterministic fetch failures ([#111](https://github.com/mrgoonie/multix-cli/issues/111)) ([8d2aa9b](https://github.com/mrgoonie/multix-cli/commit/8d2aa9baa3533cf199adc038911c9ea485b40083))

## [1.0.3](https://github.com/mrgoonie/multix-cli/compare/v1.0.2...v1.0.3) (2026-10-11)


### Fixed

* **atlascloud:** harden output downloads and base URL handling ([#100](https://github.com/mrgoonie/multix-cli/issues/100)) ([46288a2](https://github.com/mrgoonie/multix-cli/commit/46288a2e60a8a2784cfe0bd959c7dc757f03e801))

## [1.0.2](https://github.com/mrgoonie/multix-cli/compare/v1.0.1...v1.0.2) (2026-10-11)


### Fixed

* **fal:** only send the key to trusted queue status and response URLs ([#112](https://github.com/mrgoonie/multix-cli/issues/112)) ([92e61c5](https://github.com/mrgoonie/multix-cli/commit/92e61c547999e0bb30f1f4be6d9bbc1ce8226d24))

## [1.0.1](https://github.com/mrgoonie/multix-cli/compare/v1.0.0...v1.0.1) (2026-10-11)


### Changed

* **gemini:** move file-system work out of the Gemini client ([#109](https://github.com/mrgoonie/multix-cli/issues/109)) ([7df49b2](https://github.com/mrgoonie/multix-cli/commit/7df49b24994bf169cb5709adbada61663a66c786))

## [1.0.0](https://github.com/mrgoonie/multix-cli/compare/v0.15.3...v1.0.0) (2026-10-11)


### ⚠ BREAKING CHANGES

* **core:** a project `.env` can no longer redirect a provider base URL or Cloudflare routing ID while the API key comes from the shell or `~/.multix/.env`. Keep the key in the same project `.env`, move the override to `~/.multix/.env`, or opt in explicitly as described in the environment reference.

### Fixed

* **core:** only trust project .env endpoint overrides that ship their own key ([#97](https://github.com/mrgoonie/multix-cli/issues/97)) ([5c503ec](https://github.com/mrgoonie/multix-cli/commit/5c503eca08aeca6998cf5cf520180a32c0aeee0c))

## [0.15.3](https://github.com/mrgoonie/multix-cli/compare/v0.15.2...v0.15.3) (2026-10-11)


### Fixed

* **core:** never forward API-key headers across origins on redirect ([#101](https://github.com/mrgoonie/multix-cli/issues/101)) ([5fd673d](https://github.com/mrgoonie/multix-cli/commit/5fd673ddac9e30b592348cafd6ab68343fa644d7))

## [0.15.2](https://github.com/mrgoonie/multix-cli/compare/v0.15.1...v0.15.2) (2026-10-11)


### Fixed

* **doc:** do not retry configuration and non-transient errors ([#96](https://github.com/mrgoonie/multix-cli/issues/96)) ([6c505a6](https://github.com/mrgoonie/multix-cli/commit/6c505a64f88cbcc3ee992ca4112473400189305f))

## [0.15.1](https://github.com/mrgoonie/multix-cli/compare/v0.15.0...v0.15.1) (2026-10-11)


### Performance

* **gemini:** stream file uploads with resumable Files API ([#85](https://github.com/mrgoonie/multix-cli/issues/85)) ([b2cc886](https://github.com/mrgoonie/multix-cli/commit/b2cc886cf5bdf960e88aeea5155ae2623547d918))

## [0.15.0](https://github.com/mrgoonie/multix-cli/compare/v0.14.1...v0.15.0) (2026-10-11)


### Added

* **mcp:** add Streamable HTTP MCP server for Cloudflare Workers ([#91](https://github.com/mrgoonie/multix-cli/issues/91)) ([45a662c](https://github.com/mrgoonie/multix-cli/commit/45a662c638d9211009e429bc129edc913a010729))

## [0.14.1](https://github.com/mrgoonie/multix-cli/compare/v0.14.0...v0.14.1) (2026-10-11)


### Fixed

* **replicate:** harden output downloads, --prefer-wait and create errors ([#88](https://github.com/mrgoonie/multix-cli/issues/88)) ([e29e81d](https://github.com/mrgoonie/multix-cli/commit/e29e81d7b3e54e5b65f4905c1adb629f2d4df6c4))

## [0.14.0](https://github.com/mrgoonie/multix-cli/compare/v0.13.0...v0.14.0) (2026-10-11)


### Added

* **doc:** read convert input from piped stdin ([#84](https://github.com/mrgoonie/multix-cli/issues/84)) ([4596f7f](https://github.com/mrgoonie/multix-cli/commit/4596f7f09da2e8e7a95582296c220f4e007e3171))


### Fixed

* **heygen:** harden base URL, output downloads and multi-output paths ([#83](https://github.com/mrgoonie/multix-cli/issues/83)) ([fea7a95](https://github.com/mrgoonie/multix-cli/commit/fea7a950bdf37836a5344301829b028efe4c9a6d))

## [0.13.0](https://github.com/mrgoonie/multix-cli/compare/v0.12.0...v0.13.0) (2026-10-11)


### Added

* **heygen:** add HeyGen v3 provider ([#69](https://github.com/mrgoonie/multix-cli/issues/69)) ([fc04037](https://github.com/mrgoonie/multix-cli/commit/fc0403765d15d82e60d5bc533a728b6f30bd9bc5))

## [0.12.0](https://github.com/mrgoonie/multix-cli/compare/v0.11.0...v0.12.0) (2026-10-11)


### Added

* **replicate:** add direct Replicate API provider ([#67](https://github.com/mrgoonie/multix-cli/issues/67)) ([72fa63b](https://github.com/mrgoonie/multix-cli/commit/72fa63b7394a45a9128d3b9c7d2269fa96daf44a))

## [0.11.0](https://github.com/mrgoonie/multix-cli/compare/v0.10.0...v0.11.0) (2026-10-11)


### Added

* **atlascloud:** add Atlas Cloud provider ([#68](https://github.com/mrgoonie/multix-cli/issues/68)) ([39b4bb0](https://github.com/mrgoonie/multix-cli/commit/39b4bb051b3d5f04042c291b58496d2c1490a70f))

## [0.10.0](https://github.com/mrgoonie/multix-cli/compare/v0.9.0...v0.10.0) (2026-10-11)


### Added

* **gemini:** accept piped stdin via --files - ([#75](https://github.com/mrgoonie/multix-cli/issues/75)) ([6806f48](https://github.com/mrgoonie/multix-cli/commit/6806f483a841104350488e9f305db5bde66aec8e))

## [0.9.0](https://github.com/mrgoonie/multix-cli/compare/v0.8.0...v0.9.0) (2026-10-11)


### Added

* **core:** opt-in loading of legacy .claude env files ([#70](https://github.com/mrgoonie/multix-cli/issues/70)) ([48d9420](https://github.com/mrgoonie/multix-cli/commit/48d9420012a36ada0b5a35e2e51d90c1daa5042c))

## [0.8.0](https://github.com/mrgoonie/multix-cli/compare/v0.7.3...v0.8.0) (2026-10-11)


### Added

* **gemini:** rotate across GEMINI_API_KEY_N keys on quota errors ([#65](https://github.com/mrgoonie/multix-cli/issues/65)) ([d24efd3](https://github.com/mrgoonie/multix-cli/commit/d24efd36676d3823f9aac6e2aa0a8bd7a393b282))

## [0.7.3](https://github.com/mrgoonie/multix-cli/compare/v0.7.2...v0.7.3) (2026-10-11)


### Fixed

* **gemini:** use predictLongRunning for Veo and authenticate downloads ([#63](https://github.com/mrgoonie/multix-cli/issues/63)) ([e6c6613](https://github.com/mrgoonie/multix-cli/commit/e6c6613223c8bf7ceaed7dc332f87309421f2a18))

## [0.7.2](https://github.com/mrgoonie/multix-cli/compare/v0.7.1...v0.7.2) (2026-10-11)


### Documentation

* add AGENTS.md contributor and issue-label workflow ([#57](https://github.com/mrgoonie/multix-cli/issues/57)) ([2cffb46](https://github.com/mrgoonie/multix-cli/commit/2cffb46be060664539df62eaf262e8cb41bd367b))

## [0.7.1](https://github.com/mrgoonie/multix-cli/compare/v0.7.0...v0.7.1) (2026-10-05)


### Fixed

* **check:** probe ffmpeg with -version so ffmpeg 8.x is detected ([#51](https://github.com/mrgoonie/multix-cli/issues/51)) ([ca26541](https://github.com/mrgoonie/multix-cli/commit/ca265416075a0df6eecf21f3e359f7aab74bce43))

## [0.7.0](https://github.com/mrgoonie/multix-cli/compare/v0.6.0...v0.7.0) (2026-09-24)


### Added

* add self-update command, fal.ai provider, and fix release node version ([#48](https://github.com/mrgoonie/multix-cli/issues/48)) ([9881d33](https://github.com/mrgoonie/multix-cli/commit/9881d33ef336471845b933422e443ae63f973bed))
* **gemini:** add gemini 3.8 flash and flash-lite tts via interactions api ([#46](https://github.com/mrgoonie/multix-cli/issues/46)) ([216ce1f](https://github.com/mrgoonie/multix-cli/commit/216ce1f1deb4ad08cb8d04641a98646aae93d2f8))

## [0.6.0](https://github.com/mrgoonie/multix-cli/compare/v0.5.2...v0.6.0) (2026-09-23)


### Added

* **image:** convert generated images to WebP by default ([#42](https://github.com/mrgoonie/multix-cli/issues/42)) ([a2532b1](https://github.com/mrgoonie/multix-cli/commit/a2532b1bdd151d2c349b0e4a1023dbaa75c300f0))

## [0.5.2](https://github.com/mrgoonie/multix-cli/compare/v0.5.1...v0.5.2) (2026-07-30)


### Documentation

* add media prerequisites ([#40](https://github.com/mrgoonie/multix-cli/issues/40)) ([3ad9dbd](https://github.com/mrgoonie/multix-cli/commit/3ad9dbdcbc8b216833f27010ad1f568a3f7a6a86))

## [0.5.1](https://github.com/mrgoonie/multix-cli/compare/v0.5.0...v0.5.1) (2026-07-30)


### Documentation

* add provider guides and banner ([#38](https://github.com/mrgoonie/multix-cli/issues/38)) ([428390d](https://github.com/mrgoonie/multix-cli/commit/428390d399e51cff23a1f898162c6153a21a4785))

## [0.5.0](https://github.com/mrgoonie/multix-cli/compare/v0.4.0...v0.5.0) (2026-07-30)


### Added

* **gemini:** default text tasks to 3.6 Flash ([#36](https://github.com/mrgoonie/multix-cli/issues/36)) ([ec1e019](https://github.com/mrgoonie/multix-cli/commit/ec1e0193dc9f8e0570ffc0f57901d5846b44c91f))

## [0.4.0](https://github.com/mrgoonie/multix-cli/compare/v0.3.0...v0.4.0) (2026-07-30)


### Added

* add multix CLI documentation site ([#34](https://github.com/mrgoonie/multix-cli/issues/34)) ([cf2540d](https://github.com/mrgoonie/multix-cli/commit/cf2540dc9d4b7b416214395603fd071af49cf7a7))

## [0.3.0](https://github.com/mrgoonie/multix-cli/compare/v0.2.0...v0.3.0) (2026-07-29)


### Added

* **cloudflare:** add Workers AI media generation ([#26](https://github.com/mrgoonie/multix-cli/issues/26)) ([53c1831](https://github.com/mrgoonie/multix-cli/commit/53c183187571d59f350af7c769927e488afd36aa))

## [0.2.0](https://github.com/mrgoonie/multix-cli/compare/v0.1.1...v0.2.0) (2026-05-27)


### Added

* improve agent-facing command and skill descriptions ([#19](https://github.com/mrgoonie/multix-cli/issues/19)) ([a0f1dab](https://github.com/mrgoonie/multix-cli/commit/a0f1dab7e76295d5eb6a9d6dff237d28d2832596)), closes [#18](https://github.com/mrgoonie/multix-cli/issues/18)

## [0.1.1](https://github.com/mrgoonie/multix-cli/compare/v0.1.0...v0.1.1) (2026-05-20)


### Fixed

* **release:** merge release PR with explicit repo ([#15](https://github.com/mrgoonie/multix-cli/issues/15)) ([4695e3b](https://github.com/mrgoonie/multix-cli/commit/4695e3b5f6d66e59e5bb34db265beb78ae72c667))

## [0.1.0](https://github.com/mrgoonie/multix-cli/compare/v0.0.8...v0.1.0) (2026-05-20)


### Added

* **openai:** add provider media commands ([#9](https://github.com/mrgoonie/multix-cli/issues/9)) ([#11](https://github.com/mrgoonie/multix-cli/issues/11)) ([512d689](https://github.com/mrgoonie/multix-cli/commit/512d689f3fa5dcb2fb7ccce26a7d8d33b0091564))


### Fixed

* **release:** auto-complete stable releases ([#13](https://github.com/mrgoonie/multix-cli/issues/13)) ([20d65d4](https://github.com/mrgoonie/multix-cli/commit/20d65d46cbacacf28008996f7d13c0a17a00b540))
* **release:** resolve release PR without checkout ([#14](https://github.com/mrgoonie/multix-cli/issues/14)) ([64632ad](https://github.com/mrgoonie/multix-cli/commit/64632ad08e71a3ed94ac3b12f136403cd9c15651))

## [0.0.8] - 2026-05-11

### Fixed
- `multix openrouter image-to-image` previously failed for any non-Gemini text+image model (e.g. `openai/gpt-5.4-image-2`, `openai/gpt-5-image-mini`, `recraft/recraft-v3`) because the `modalities` heuristic forced `["image"]` for non-Gemini models. The new default is `["image","text"]`, with `["image"]` only emitted for verified image-only families (`black-forest-labs/`, `bytedance-seed/seedream`, `sourceful/`).
- "No images in response" errors now include the model id, `finish_reason`, the model's text reply (if any), and a hint about modalities — previously a single generic line.

### Added
- `multix openrouter image-to-image --strength <0..1>` — Recraft init-image strength control.
- `OPENROUTER_FALLBACK_MODELS` (CSV) now applies to `image-to-image` (previously `generate` only). Sends `models: [primary, ...fallbacks]` so OpenRouter can route on availability.
- New shared module `src/providers/openrouter/payload.ts` — `resolveModalities`, `buildOpenRouterHeaders`, `extractImagesFromResponse`, `formatNoImagesError`, `buildI2IPayload`. DRY across `generate` + `image-to-image`.

### Changed
- README and `skill/SKILL.md` document the OpenRouter model-family matrix (Gemini / OpenAI gpt-image / Recraft → text+image; Flux 2.x / Seedream 4.5 / Sourceful → image-only) and the new flags.

### Verified live
`openai/gpt-5.4-image-2`, `openai/gpt-5-image-mini`, `google/gemini-2.5-flash-image`, `black-forest-labs/flux.2-pro`, `flux.2-max`, `flux.2-flex`, `bytedance-seed/seedream-4.5`.

## [0.0.7] - 2026-05-05

### Added
- **ElevenLabs provider** — full integration with 13 subcommands:
  - `tts` — text-to-speech (sync audio bytes) with voice settings, language code, seed, context continuity, and `--no-speaker-boost` opt-out.
  - `voices list|get|search|design|create-from-preview|delete` — voice library management and prompt-based voice design.
  - `clone` — instant voice cloning via multipart audio sample upload.
  - `voice-changer` — speech-to-speech voice conversion.
  - `transcribe` — Scribe STT with diarization, audio-event tagging, and `text|json|srt|vtt` output.
  - `sfx` — sound effects generation with prompt influence and looping.
  - `music` — music generation (`music_v1`) from prompt or composition plan.
  - `dub` / `dub-status` — async dubbing with `--wait` / `--download` polling and per-language audio download.
  - `isolate` — voice isolator (background noise removal).
  - `align` — forced alignment (transcript ↔ audio timing).
  - `account` / `models` — usage / subscription tier and model catalog.
- `ELEVENLABS_RECOMMENDED_VOICES` with 11 verified conversational voice IDs (Alexandra default).
- TTS models: `eleven_multilingual_v2` (default), `eleven_flash_v2_5`, `eleven_flash_v2`, `eleven_turbo_v2_5`, `eleven_turbo_v2`, `eleven_v3`. STT: `scribe_v1`, `scribe_v1_experimental`. Voice changer: `eleven_multilingual_sts_v2`. Output formats: `mp3_*`, `pcm_*`, `ulaw_8000`.
- `multix check` and `.env.example` document `ELEVENLABS_API_KEY`.

## [0.0.6] - 2026-05-05

### Added
- `multix byteplus generate-3d` (alias `3d`) — BytePlus Hyper3D / Hitem3d 3D generation on the ARK async tasks endpoint. Models: `hyper3d-gen2-260112` (text-to-3D + image-to-3D, 1–5 refs), `hitem3d-2-0-251223` (image-to-3D). Provider-specific knobs (`--mesh_mode`, `--hd_texture`, `--material`, `--ff`, `--resolution`, …) passed via `--flags <raw>` pass-through. Auto-detects output extension (`.glb` / `.gltf` / `.zip` …) from response URL.
- `multix byteplus status --download` extended to also fetch `content.file_url` for 3D tasks alongside `content.video_url` for video.
- New env override: `BYTEPLUS_3D_MODEL` (default `hyper3d-gen2-260112`).

## [0.0.5] - 2026-05-05

### Added
- `multix <provider> image-to-image` (alias `i2i`) for all five providers — BytePlus (Seedream multi-ref), Gemini (Nano Banana edit/compose), OpenRouter (chat-image with `image_url` parts), Leonardo (init image via existing imageId), MiniMax (subject_reference; CAVEAT: not free-form editing — preserves character identity in a new prompt).
- Promoted `src/core/image-input.ts` (URL / local-file resolver, base64 inlining with configurable size caps) so all providers share one resolver.

## [0.0.4] - 2026-05-04

### Added
- `--wait` / `--wait-timeout` / `--download` / `--output` / `--no-thumb` flags across all video commands (BytePlus, Gemini, Leonardo, MiniMax, OpenRouter) for unified poll-and-download UX.
- Auto-detection and download of video thumbnails (`cover_image_url`, `thumbnail_url`, `first_frame_url`, etc.) saved beside the video as `<base>_thumb.<ext>`.
- `multix leonardo status` now supports `--wait` / `--download`; `multix openrouter video-status` now polls properly instead of single GET.
- `.env.example` documenting all supported environment variables (provider keys, model overrides, CLI behavior).
- Core helper `src/core/video-thumb.ts` with `detectThumbUrl`, `downloadThumbBeside`, `maybeDownloadThumb`.

## [0.0.3] - 2026-05-03

### Added
- `multix gemini generate-speech` — Gemini 3.1 Flash TTS with single- and multi-speaker (max 2) modes, 30 prebuilt voices, WAV (default) or raw PCM output. Models: `gemini-3.1-flash-tts-preview` (default), `gemini-2.5-flash-preview-tts`, `gemini-2.5-pro-preview-tts`. Env: `GEMINI_TTS_MODEL` / `TTS_MODEL`.
- `multix byteplus` — BytePlus provider: Seedream 4.0 image generation (`generate`), Seedance 2.0 text-to-video (`video`), image-to-video (`image-to-video` / `i2v`), reference-to-video with up to 9 image + 3 video + 3 audio refs (`reference-to-video` / `r2v`), task polling (`status`). Env: `BYTEPLUS_API_KEY` (or `ARK_API_KEY`), plus model + base-url overrides.
- `multix check` now reports BytePlus key status alongside the other providers.

## [0.0.1] - 2026-05-02

### Added
- Initial release — TypeScript/ESM port of Python `ai-multimodal` skill scripts.
- `multix gemini` — analyze, transcribe, extract, generate images (Nano Banana / Imagen 4), generate-video (Veo, experimental).
- `multix minimax` — image, video (async polling), speech (TTS), music generation.
- `multix openrouter` — image generation via chat completions API with fallback model support.
- `multix media` — optimize video/audio/images (ffmpeg + ImageMagick), split long videos, batch process directories.
- `multix doc` — convert PDFs, Office docs, images to Markdown via Gemini Files API.
- `multix check` — diagnostics: tooling presence, API key validation, Gemini live ping, setup hints.
- Shared core: env loader (layered .env), result type, HTTP client (globalThis.fetch), output dir, ANSI logger.
- Vitest unit + smoke tests (103 tests); GitHub Actions CI on Node 20/22 × Ubuntu/Windows.
- Companion `skill/SKILL.md` for Claude Code skill catalog.
