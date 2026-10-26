# The connector agent — one image for the operator's pooled agent in the
# platform's shared stack and for the container a household runs at home.
# It carries EVERY provider pack and attaches to as many control planes as
# it is told (ConnectorAgent__Connections__<n>__*): one browser root, one
# job at a time, one thing to keep running. Build context is `server`:
#
#   docker build -f src/connectors/Connector.Agent/Dockerfile server
#
# It is an AGENT image, and both properties that follow from that are
# enforced here rather than by convention:
#
#   * It gets NO database credential. An agent leases work over HTTP and
#     has no route to Postgres at all.
#   * It publishes NO port. Every call is outbound from the agent, which is
#     what lets one run behind NAT on a residential line or on a user's own
#     machine without an inbound hole — and a residential line is exactly
#     what some of these providers need: DUO's manifest requires the account
#     holder's own agent because DigiD's operator scores sign-ins on the
#     address they come from, and BKR wants a Dutch residential one too.
#
# amd64 only in CI: Chromium under Playwright on arm64 is unverified.

FROM mcr.microsoft.com/dotnet/sdk:11.0 AS build
WORKDIR /src

# Restore from project files alone, so editing a .cs file does not
# re-resolve the package graph. Any new project in this image's reference
# chain has to be added here as well — and this image's chain is every
# adapter library in the repository, which is the price of being the one
# container a person installs.
COPY src/connectors/Directory.Build.props src/connectors/Directory.Packages.props src/connectors/
COPY src/connectors/Connector.Kit/Connector.Kit.csproj src/connectors/Connector.Kit/
COPY src/connectors/Connector.Kit.Agent/Connector.Kit.Agent.csproj src/connectors/Connector.Kit.Agent/
COPY src/connectors/BankConnector.Adapters/BankConnector.Adapters.csproj src/connectors/BankConnector.Adapters/
COPY src/connectors/ShopConnector.Adapters/ShopConnector.Adapters.csproj src/connectors/ShopConnector.Adapters/
COPY src/connectors/RegistryConnector.Adapters/RegistryConnector.Adapters.csproj src/connectors/RegistryConnector.Adapters/
COPY src/connectors/Connector.Agent/Connector.Agent.csproj src/connectors/Connector.Agent/
RUN dotnet restore src/connectors/Connector.Agent/Connector.Agent.csproj -r linux-x64

COPY src/connectors/ src/connectors/

# Self-contained on purpose. The Playwright image is here for BROWSERS;
# tying the agent to whatever .NET version that image happens to ship would
# couple an agent release to Playwright's base-image cadence, and a
# mismatch is a runtime failure on a residential box nobody is watching.
RUN dotnet publish src/connectors/Connector.Agent/Connector.Agent.csproj \
    -c Release -r linux-x64 --self-contained true -o /app --no-restore \
    -p:ContinuousIntegrationBuild=true

# Tag tracks the Microsoft.Playwright version in Directory.Packages.props.
# The driver and the browser bundles are versioned together; a drift
# between them fails at launch, not at build.
FROM mcr.microsoft.com/playwright/dotnet:v1.61.0-noble

# The section is ConnectorAgent and the properties are the full
# ...Directory names — a shorter spelling binds to nothing and the agent
# silently uses a home-directory default while the compose file mounts
# volumes nothing ever writes to.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false \
    ConnectorAgent__ProfileRootDirectory=/profiles \
    ConnectorAgent__WorkRootDirectory=/work \
    ConnectorAgent__StateFilePath=/state/agent-state.json

ARG BUILD_NUMBER=0
ENV BUILD_NUMBER=${BUILD_NUMBER}

LABEL org.opencontainers.image.title="connector-agent" \
      org.opencontainers.image.description="munni connector agent - every provider pack, one container, outbound only" \
      org.opencontainers.image.source="https://github.com/okkes/munnimok"

# /profiles is the persistent-profile store and the one directory that must
# survive a restart — it holds logged-in browser sessions on hardware the
# user controls, one sub-directory per control plane this agent serves.
# /work is scratch for a single job and is emptied when it ends, including
# on failure: a downloaded bank statement left on disk is exactly the leak
# this architecture exists to prevent. /state holds the enrollments — one
# entry per control plane — and an agent that loses it comes back as a
# stranger and needs a fresh one-time code for every one of them.
RUN mkdir -p /profiles /work /state /app && chown -R pwuser /profiles /work /state /app

WORKDIR /app
COPY --from=build --chown=pwuser /app .

# Starts Xvfb so the browser can run genuinely headed. See the script for
# why that is a correctness fix and not a disguise.
#
# Root-owned and read-only: this runs before the agent does, so a process
# that could rewrite it could run anything it liked as the next restart.
# pwuser needs to execute it, never to change it.
COPY src/connectors/Connector.Agent/entrypoint.sh /usr/local/bin/agent-entrypoint.sh
RUN chmod 0555 /usr/local/bin/agent-entrypoint.sh

# pwuser ships with the Playwright image and owns the browser bundles. A
# browser rendering a hostile page must never be root.
USER pwuser
ENTRYPOINT ["/usr/local/bin/agent-entrypoint.sh", "./Connector.Agent"]
