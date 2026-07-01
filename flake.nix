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
        let cfg = config.services.selphy-print;
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

            iccProfile = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = null;
              description = "ICC profile applied to every print (null = no color management).";
            };

            iccIntent = lib.mkOption {
              type = lib.types.enum [ "perceptual" "relative" "saturation" "absolute" ];
              default = "perceptual";
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
              } // lib.optionalAttrs (cfg.overscanMm != null) {
                OVERSCAN_MM = cfg.overscanMm;
              } // lib.optionalAttrs (cfg.iccProfile != null) {
                ICC_PROFILE = toString cfg.iccProfile;
              };
              serviceConfig = {
                ExecStart = lib.getExe cfg.package;
                DynamicUser = true;
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
