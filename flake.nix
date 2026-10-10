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
              pkgs.makeWrapper
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
              cp -R dist package.json pnpm-lock.yaml README.md LICENSE docs "$out/lib/bioflow/"
              mkdir -p "$out/lib/bioflow/node_modules" "$out/bin"
              # Copy the two pinned runtime packages, not build-time dependencies or
              # pnpm symlinks pointing into the temporary build directory.
              cp -RL node_modules/yaml node_modules/zod "$out/lib/bioflow/node_modules/"
              makeWrapper ${pkgs.nodejs_22}/bin/node "$out/bin/bioflow" \
                --add-flags "$out/lib/bioflow/dist/cli/main.js"
              makeWrapper ${pkgs.nodejs_22}/bin/node "$out/bin/bioflow-mcp" \
                --add-flags "$out/lib/bioflow/dist/mcp/main.js"
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
                export GOMAXPROCS="$NIX_BUILD_CORES"
                substituteInPlace package.json \
                  --replace-fail 'vitest run' "vitest run --maxWorkers=$NIX_BUILD_CORES --minWorkers=1"
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
          installed-cli = pkgs.runCommand "bioflow-installed-cli-${version}" {
            nativeBuildInputs = [ self.packages.${system}.bioflow pkgs.nodejs_22 ];
          } ''
            export HOME="$TMPDIR/home"
            mkdir -p "$HOME"
            cd "$TMPDIR"
            printf 'Sample_ID,Index,Note\nalpha-1,acgt,"quoted, metadata"\n' > sample.csv
            bioflow --help | grep -F 'Usage:'
            bioflow tidy sample.csv --base-dir ./evidence --run-id nix-installed-smoke --out ./cleaned
            bioflow verify nix-installed-smoke --base-dir ./evidence
            bioflow report nix-installed-smoke --base-dir ./evidence --out ./reports
            grep -F 'ALPHA_1,ACGT,"quoted, metadata"' cleaned/tidy.sample-sheet-v1.data.csv
            printf 'Sample_ID,Index\nalpha,ACGT,extra\n' > malformed.csv
            status=0
            bioflow tidy malformed.csv --base-dir ./evidence --out ./rejected || status=$?
            test "$status" -eq 1
            test ! -e rejected
            # Launch the actual installed MCP wrapper without the source checkout.
            export BIOFLOW_MCP_REPO_ROOT="$TMPDIR/mcp-workspace"
            mkdir -p "$BIOFLOW_MCP_REPO_ROOT/docs/wiki"
            cp ${self.packages.${system}.bioflow}/lib/bioflow/package.json "$BIOFLOW_MCP_REPO_ROOT/"
            printf '# Smoke workspace\n' > "$BIOFLOW_MCP_REPO_ROOT/docs/wiki/index.md"
            node -e 'const fs = require("fs"); const {spawnSync} = require("child_process"); const body = JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"nix-smoke",version:"1"}}}); const input = "Content-Length: " + Buffer.byteLength(body) + "\r\n\r\n" + body; const child = spawnSync("bioflow-mcp", [], {input, encoding:"utf8", timeout:10000}); if (child.status !== 0) throw new Error(child.stderr || "MCP process failed"); fs.writeFileSync("mcp-response.json", child.stdout); const response = JSON.parse(child.stdout.slice(child.stdout.indexOf("\r\n\r\n") + 4)); if (response.id !== 1 || response.result?.protocolVersion !== "2025-11-25") throw new Error("MCP initialize failed");'
            mkdir -p "$out"
            cp mcp-response.json "$out/"
            touch "$out/installed-cli"
          '';
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
            command = "npm run demo:workflow:ci";
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
