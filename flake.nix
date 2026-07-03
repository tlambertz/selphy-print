{
  description = "PWA print server for Canon SELPHY CP1500 with ICC color management";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      forAllSystems = f: nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ]
        (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        default = selphy-print;
        selphy-print = pkgs.buildNpmPackage {
          pname = "selphy-print";
          version = "0.1.0";
          src = ./.;

          # First build will fail and print the real hash — paste it here.
          npmDepsHash = pkgs.lib.fakeHash;

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
