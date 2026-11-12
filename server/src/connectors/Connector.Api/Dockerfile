# The connector control plane of one munni environment — every provider pack
# (banks, shops, registries) under one catalogue, one database, one consumer
# credential. Build context is `server` (like the sync API):
#
#   docker build -f src/connectors/Connector.Api/Dockerfile server
#
# Arch-agnostic on purpose — CI builds it natively once per architecture
# (amd64 NAS, arm64 Pi) and merges the two into one manifest tag; no QEMU.
#
# There are deliberately NO browser binaries here. The control plane never
# touches a provider, and an image without Chromium cannot start one by
# accident on the wrong egress.

FROM mcr.microsoft.com/dotnet/sdk:11.0-alpine AS build
WORKDIR /src

# Restore from project files alone, so editing a .cs file does not
# re-resolve the package graph. Any new project in this image's reference
# chain has to be added here as well.
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

# icu-libs: money and dates are formatted and parsed server-side, and
# invariant mode silently changes both.
# tzdata: a purchase near midnight lands on the wrong day without a real
# Europe/Amsterdam offset, and a receipt on the wrong day matches the wrong
# bank transaction.
# krb5-libs: Npgsql loads libgssapi_krb5 for the authentication handshake and
# the alpine base does not ship it — without it every database command fails
# and the container never turns healthy (found by bringing the rendered
# environment up locally, #367 M2)
RUN apk add --no-cache icu-libs tzdata krb5-libs
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false

ARG BUILD_NUMBER=0
# Reported as service.version in the catalogue response, so an operator can
# tell which build answered a call.
ENV BUILD_NUMBER=${BUILD_NUMBER}

LABEL org.opencontainers.image.title="connector-api" \
      org.opencontainers.image.description="munni connector control plane - catalogue, sessions, jobs, challenges, agents" \
      org.opencontainers.image.source="https://github.com/okkes/munnimok"

WORKDIR /app
COPY --from=build /app .
USER app
# 8080 answers the consumer (munni's API) and the agents; nothing is published outside the stack network
EXPOSE 8080
ENTRYPOINT ["dotnet", "Connector.Api.dll"]
