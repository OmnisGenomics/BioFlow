{
  description = "BioFlow CLI and MCP";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixpkgs-node20.url = "github:NixOS/nixpkgs/nixos-25.05";
  };

  outputs = { self, nixpkgs, nixpkgs-node20 }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: nixpkgs.legacyPackages.${system};
      node20PkgsFor = system: nixpkgs-node20.legacyPackages.${system};
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = pkgsFor system;
          packageJson = builtins.fromJSON (builtins.readFile ./package.json);
          pname = "bioflow";
          version = packageJson.version;
          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit pname version;
            src = ./.;
            hash = "sha256-rxMM+o786sMQgjtUMvPIBjDnz/LArxMl3Eahu4bXT9Q=";
            fetcherVersion = 4;
          };
          bioflow = pkgs.stdenv.mkDerivation {
            inherit pname version pnpmDeps;
            src = ./.;

            nativeBuildInputs = [
              pkgs.nodejs_22
              pkgs.pnpm
              pkgs.pnpmConfigHook
            ];

            npm_config_manage_package_manager_versions = "false";

            buildPhase = ''
              runHook preBuild
              pnpm --config.manage-package-manager-versions=false run build
              patchShebangs dist/cli/main.js dist/mcp/main.js
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              mkdir -p "$out/lib/bioflow"
              cp -R dist package.json pnpm-lock.yaml "$out/lib/bioflow/"
              runHook postInstall
            '';

            meta = {
              description = packageJson.description or "BioFlow CLI and MCP";
              homepage = "https://github.com/OmnisGenomics/BioFlow";
              license = pkgs.lib.licenses.asl20;
            };
          };
        in
        {
          default = bioflow;
          bioflow = bioflow;
        });

      checks = forAllSystems (system:
        let
          pkgs = pkgsFor system;
          node20Pkgs = node20PkgsFor system;
          packageJson = builtins.fromJSON (builtins.readFile ./package.json);
          pname = "bioflow";
          version = packageJson.version;
          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit pname version;
            src = ./.;
            hash = "sha256-rxMM+o786sMQgjtUMvPIBjDnz/LArxMl3Eahu4bXT9Q=";
            fetcherVersion = 4;
          };

          mkCheck = { name, command, nodejs ? pkgs.nodejs_22, extraInputs ? [ ] }:
            pkgs.stdenv.mkDerivation {
              inherit pname version pnpmDeps;
              name = "${pname}-${name}-${version}";
              src = ./.;

              nativeBuildInputs = [
                nodejs
                pkgs.pnpm
                pkgs.pnpmConfigHook
              ] ++ extraInputs;

              npm_config_manage_package_manager_versions = "false";

              dontBuild = true;
              installPhase = ''
                runHook preInstall
                export HOME="$(mktemp -d)"
                export TMPDIR="$(mktemp -d)"
                ${command}
                mkdir -p "$out"
                touch "$out/${name}"
                runHook postInstall
              '';
            };
        in
        {
          default = self.checks.${system}.ci;
          package = self.packages.${system}.bioflow;
          golden-node20 = mkCheck {
            name = "golden-node20";
            nodejs = node20Pkgs.nodejs_20;
            command = "npm run verify:golden";
          };
          golden-node22 = mkCheck {
            name = "golden-node22";
            command = "npm run verify:golden";
          };
          ci = mkCheck {
            name = "ci";
            command = "npm run check";
          };
          package-smoke = mkCheck {
            name = "package-smoke";
            command = ''
              npm run build
              patchShebangs dist/cli/main.js dist/mcp/main.js

              pack_json="$TMPDIR/npm-pack.json"
              npm pack --json > "$pack_json"
              tarball="$(node -e 'const fs = require("fs"); const packed = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(packed[0].filename);' "$pack_json")"

              package_dir="$TMPDIR/package-smoke"
              mkdir -p "$package_dir"
              tar -xzf "$tarball" -C "$package_dir"
              test -f "$package_dir/package/dist/cli/main.js"
              test -f "$package_dir/package/dist/mcp/main.js"
              ln -s "$PWD/node_modules" "$package_dir/package/node_modules"

              node "$package_dir/package/dist/cli/main.js" --help | grep -F "Usage:"
              autopilot_status=0
              autopilot_help="$(node "$package_dir/package/dist/cli/main.js" autopilot:run --help)" || autopilot_status=$?
              test "$autopilot_status" -eq 2
              printf '%s\n' "$autopilot_help" | grep -F "bioflow autopilot:run"

              node --input-type=module \
                -e 'const modulePath = process.argv[1]; process.argv[1] = ""; await import(modulePath);' \
                "$package_dir/package/dist/mcp/main.js"
            '';
          };
          demo-killer = mkCheck {
            name = "demo-killer";
            command = "npm run demo:killer:ci";
          };
          cli-autopilot-flow = mkCheck {
            name = "cli-autopilot-flow";
            command = ''
              export BIOFLOW_AUTOPILOT_FLOW_OUT=.bioflow_smoke_service/cli-autopilot-run-flow-summary.json
              npm run test -- test/cli-autopilot-run-flow.test.ts
              test -s "$BIOFLOW_AUTOPILOT_FLOW_OUT"
            '';
          };
        });

      apps = forAllSystems (system:
        let
          pkgs = pkgsFor system;
          app = pkgs.writeShellApplication {
            name = "bioflow-conventional-commits";
            runtimeInputs = [
              pkgs.git
              pkgs.python312
            ];
            text = ''
              mkdir -p out
              rev_range="''${1:-HEAD~1..HEAD}"
              exec bash scripts/conventional-commit-check.sh \
                --rev-range "$rev_range" \
                --output out/conventional-commits-summary.json \
                --allow-merge-commits \
                --allow-git-revert
            '';
          };
        in
        {
          conventional-commits = {
            type = "app";
            program = "${app}/bin/bioflow-conventional-commits";
          };
        });

      devShells = forAllSystems (system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_22
              pkgs.pnpm
              pkgs.python312
            ];
          };
        });
    };
}
