# The connector control plane of one munni environment — every provider pack
# (banks, shops, registries) under one catalogue, one database, one consumer
# credential. Build context is `server` (like the sync API):
#
#   docker build -f src/connectors/Connector.Api/Dockerfile server
#
# Arch-agnostic: CI builds natively per architecture (amd64 NAS, arm64 Pi) and merges one manifest; no QEMU.
#
# No browser binaries on purpose: without Chromium it cannot start a provider session on the wrong egress.

FROM mcr.microsoft.com/dotnet/sdk:11.0-alpine AS build
WORKDIR /src

# restore from project files alone; every project in the reference chain must be listed
COPY src/connectors/Directory.Build.props src/connectors/Directory.Packages.props src/connectors/
COPY src/connectors/Connector.Kit/Connector.Kit.csproj src/connectors/Connector.Kit/
COPY src/connectors/Connector.Kit.Hosting/Connector.Kit.Hosting.csproj src/connectors/Connector.Kit.Hosting/
COPY src/connectors/BankConnector.Adapters/BankConnector.Adapters.csproj src/connectors/BankConnector.Adapters/
COPY src/connectors/ShopConnector.Adapters/ShopConnector.Adapters.csproj src/connectors/ShopConnector.Adapters/
COPY src/connectors/RegistryConnector.Adapters/RegistryConnector.Adapters.csproj src/connectors/RegistryConnector.Adapters/
COPY src/connectors/Connector.Api/Connector.Api.csproj src/connectors/Connector.Api/
RUN dotnet restore src/connectors/Connector.Api/Connector.Api.csproj

COPY src/connectors/ src/connectors/
RUN dotnet publish src/connectors/Connector.Api/Connector.Api.csproj \
    -c Release -o /app --no-restore -p:ContinuousIntegrationBuild=true

FROM mcr.microsoft.com/dotnet/aspnet:11.0-alpine

# icu-libs: invariant mode silently changes money/date formatting and parsing
# tzdata: without the Europe/Amsterdam offset a late purchase lands on the wrong day and matches the wrong bank transaction
# krb5-libs: Npgsql loads libgssapi_krb5, alpine lacks it: every database command fails and the container never turns healthy (#367)
RUN apk add --no-cache icu-libs tzdata krb5-libs
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false

ARG BUILD_NUMBER=0
# reported as service.version in the catalogue response
ENV BUILD_NUMBER=${BUILD_NUMBER}

LABEL org.opencontainers.image.title="connector-api" \
      org.opencontainers.image.description="munni connector control plane - catalogue, sessions, jobs, challenges, agents" \
      org.opencontainers.image.source="https://github.com/okkes/munnimok"

WORKDIR /app
COPY --from=build /app .
USER app
# consumer (munni's API) and agents; not published outside the stack network
EXPOSE 8080
ENTRYPOINT ["dotnet", "Connector.Api.dll"]
