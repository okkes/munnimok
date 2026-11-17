# The connector agent — one image for the operator's pooled agent in the
# platform's shared stack and for the container a household runs at home.
# It carries EVERY provider pack and attaches to as many control planes as
# it is told (ConnectorAgent__Connections__<n>__*): one browser root, one
# job at a time, one thing to keep running. Build context is `server`:
#
#   docker build -f src/connectors/Connector.Agent/Dockerfile server
#
# No database credential and no published port: all calls are outbound, so it runs behind NAT on a
# residential line (DUO needs the account holder's own agent: DigiD scores sign-ins by address; BKR wants Dutch residential).
#
# amd64 only in CI: Chromium under Playwright on arm64 is unverified.

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# restore from project files alone; every project in the reference chain (all adapter libraries) must be listed
COPY src/connectors/Directory.Build.props src/connectors/Directory.Packages.props src/connectors/
COPY src/connectors/Connector.Kit/Connector.Kit.csproj src/connectors/Connector.Kit/
COPY src/connectors/Connector.Kit.Agent/Connector.Kit.Agent.csproj src/connectors/Connector.Kit.Agent/
COPY src/connectors/BankConnector.Adapters/BankConnector.Adapters.csproj src/connectors/BankConnector.Adapters/
COPY src/connectors/ShopConnector.Adapters/ShopConnector.Adapters.csproj src/connectors/ShopConnector.Adapters/
COPY src/connectors/RegistryConnector.Adapters/RegistryConnector.Adapters.csproj src/connectors/RegistryConnector.Adapters/
COPY src/connectors/Connector.Agent/Connector.Agent.csproj src/connectors/Connector.Agent/
RUN dotnet restore src/connectors/Connector.Agent/Connector.Agent.csproj -r linux-x64

COPY src/connectors/ src/connectors/

# self-contained: the Playwright image is for browsers only; its .NET version must not gate agent releases
RUN dotnet publish src/connectors/Connector.Agent/Connector.Agent.csproj \
    -c Release -r linux-x64 --self-contained true -o /app --no-restore \
    -p:ContinuousIntegrationBuild=true

# tag tracks Microsoft.Playwright in Directory.Packages.props: driver/browser drift fails at launch, not build;
# renovate.json moves both in one PR (#562)
FROM mcr.microsoft.com/playwright/dotnet:v1.64.1-noble

# full property names: a shorter spelling binds to nothing and the agent silently uses a home-directory default
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

# /profiles (logged-in sessions) must survive restarts; /work is emptied after every job, failures included
# (a leftover bank statement is a leak); losing /state means a fresh one-time code per control plane
RUN mkdir -p /profiles /work /state /app && chown -R pwuser /profiles /work /state /app

WORKDIR /app
COPY --from=build --chown=pwuser /app .

# root-owned, read-only: it runs before the agent, so a rewritable script is code execution at next restart
COPY src/connectors/Connector.Agent/entrypoint.sh /usr/local/bin/agent-entrypoint.sh
RUN chmod 0555 /usr/local/bin/agent-entrypoint.sh

# a browser rendering a hostile page must never be root
USER pwuser
ENTRYPOINT ["/usr/local/bin/agent-entrypoint.sh", "./Connector.Agent"]
