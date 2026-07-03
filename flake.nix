{
  description = "PWA print server for Canon SELPHY CP1500 with ICC color management";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems
        (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        default = selphy-print;
        selphy-print = pkgs.buildNpmPackage {
          pname = "selphy-print";
          version = "0.1.0";
          src = ./.;

          npmDepsHash = "sha256-PKnUvDsyN1j8YEwwHibnu7X+RmOQdnOpJOKR88OfB1w=";

          # Runtime needs prod deps only; skipping devDependencies also avoids
          # puppeteer's install hook (it would try to download Chrome, which
          # fails in the sandbox). e2e/tests aren't run in the Nix build.
          npmInstallFlags = [ "--omit=dev" ];

          dontNpmBuild = true;

          nativeBuildInputs = [ pkgs.makeWrapper ];

          postInstall = ''
            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/selphy-print \
              --add-flags "$out/lib/node_modules/selphy-print/server/index.js" \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.lcms2 ]}
          '';

          meta.mainProgram = "selphy-print";
        };
      });

      # `nix run .#build-apk` compiles the Android companion app into
      # web/selphy-share.apk, using a pinned Android SDK + gradle. It runs
      # gradle at invocation time (not in the build sandbox), so it can fetch
      # the Android Gradle Plugin and auto-generate the signing keystore — the
      # Nix equivalent of the Dockerfile's APK build stage.
      apps = nixpkgs.lib.genAttrs systems (system:
        let
          pkgs = import nixpkgs {
            inherit system;
            config = { allowUnfree = true; android_sdk.accept_license = true; };
          };
          androidSdk = (pkgs.androidenv.composeAndroidPackages {
            platformVersions = [ "35" ];
            buildToolsVersions = [ "35.0.0" ];
            cmdLineToolsVersion = "13.0";
            includeEmulator = false;
            includeSystemImages = false;
            includeNDK = false;
          }).androidsdk;
          buildApk = pkgs.writeShellApplication {
            name = "build-apk";
            runtimeInputs = [ pkgs.gradle pkgs.jdk17 ];
            text = ''
              root="$(pwd)"
              if [ ! -f "$root/android/app/build.gradle" ]; then
                echo "error: run this from the selphy-print repo root" >&2
                exit 1
              fi
              export ANDROID_SDK_ROOT="${androidSdk}/libexec/android-sdk"
              export ANDROID_HOME="$ANDROID_SDK_ROOT"
              export JAVA_HOME="${pkgs.jdk17.home}"
              echo "Building the companion APK (fetches the Android Gradle Plugin on first run)…"
              ( cd "$root/android" && gradle --no-daemon assembleRelease )
              install -Dm644 "$root"/android/app/build/outputs/apk/release/*.apk "$root/web/selphy-share.apk"
              echo "wrote $root/web/selphy-share.apk"
            '';
          };
        in {
          build-apk = {
            type = "app";
            program = "${buildApk}/bin/build-apk";
            meta.description = "Compile the Android companion APK into web/selphy-share.apk";
          };
        });

      nixosModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.services.selphy-print;
          # The two free CP1500 profiles, fetched at build time (not vendored —
          # redistribution terms are unclear). Auto-discovered by the server;
          # selectable per photo in the app. Override via services.selphy-print.iccProfilesDir.
          defaultProfiles = pkgs.runCommand "selphy-cp1500-icc-profiles" { } ''
            mkdir -p $out
            cp ${pkgs.fetchurl {
              url = "https://files.farbenwerk.com/dl/icc-dl-fw/ICC-Profile165-CP1500.icc";
              hash = "sha256-w3SjhqZb0mTV3OMExFO0uh2oWxVSHbPzIScFTb7Ih2k=";
            }} $out/CP1500-farbenwerk.icc
            cp ${pkgs.fetchurl {
              url = "https://www.objektiv-guide.de/downloads/Canon_Selphy_CP1500.icc";
              hash = "sha256-1wXkPyKFakPjF0joz2Zz2JCt+z/4xmaXlY/qlMZ8aGg=";
            }} $out/Canon_Selphy_CP1500-objektiv.icc
          '';
        in {
          options.services.selphy-print = {
            enable = lib.mkEnableOption "SELPHY CP1500 print server";

            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.system}.selphy-print;
            };

            port = lib.mkOption {
              type = lib.types.port;
              default = 8080;
            };

            printerHost = lib.mkOption {
              type = lib.types.str;
              example = "192.168.1.42";
              description = "IP or hostname of the SELPHY CP1500.";
            };

            iccProfilesDir = lib.mkOption {
              type = lib.types.path;
              default = defaultProfiles;
              description = ''
                Directory of selectable *.icc profiles, auto-discovered by the
                server and chosen per photo in the app. Defaults to the two free
                CP1500 profiles fetched at build time.
              '';
            };

            iccProfile = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = null;
              description = ''
                Pin a specific default profile (must exist; overrides the
                auto-picked default). Colour is otherwise chosen per photo in the
                app: an ICC profile, the printer's firmware auto-correct, or off.
              '';
            };

            iccIntent = lib.mkOption {
              type = lib.types.enum [ "perceptual" "relative" "saturation" "absolute" ];
              default = "relative";
              description = "ICC rendering intent (relative colorimetric + black-point compensation is the photo-printing default).";
            };

            # Borderless trim per edge in mm, "top,bottom,left,right" in the
            # crop editor's orientation — measure with the in-app calibration
            # page (T/B/L/R letters). null = built-in defaults.
            overscanMm = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "2.5,2.5,4.2,5.8";
              description = "Safe-area insets, top,bottom,left,right in mm.";
            };

            openFirewall = lib.mkOption {
              type = lib.types.bool;
              default = false;
            };
          };

          config = lib.mkIf cfg.enable {
            systemd.services.selphy-print = {
              description = "SELPHY CP1500 print server";
              wantedBy = [ "multi-user.target" ];
              after = [ "network-online.target" ];
              wants = [ "network-online.target" ];
              environment = {
                PORT = toString cfg.port;
                PRINTER_HOST = cfg.printerHost;
                ICC_INTENT = cfg.iccIntent;
                ICC_DIR = toString cfg.iccProfilesDir;
                # Archive every print under the service's StateDirectory.
                PRINT_ARCHIVE_DIR = "/var/lib/selphy-print/archive";
              } // lib.optionalAttrs (cfg.overscanMm != null) {
                OVERSCAN_MM = cfg.overscanMm;
              } // lib.optionalAttrs (cfg.iccProfile != null) {
                ICC_PROFILE = toString cfg.iccProfile;
              };
              serviceConfig = {
                ExecStart = lib.getExe cfg.package;
                DynamicUser = true;
                # Writable /var/lib/selphy-print for the print archive.
                StateDirectory = "selphy-print";
                Restart = "on-failure";
                # sharp/libvips writes temp files during conversion
                PrivateTmp = true;
                ProtectSystem = "strict";
                ProtectHome = true;
                NoNewPrivileges = true;
              };
            };

            networking.firewall.allowedTCPPorts =
              lib.mkIf cfg.openFirewall [ cfg.port ];
          };
        };
    };
}
