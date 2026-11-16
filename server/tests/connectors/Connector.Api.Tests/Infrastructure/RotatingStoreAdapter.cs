using Connector.Kit;
using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;

namespace Connector.Api.Tests.Infrastructure;

// T1 store whose refresh token rotates on every fetch and whose receipts declare an operator-only param:
// no shipped mock returns RefreshedMaterial or declares an internal param
internal sealed class RotatingStoreAdapter : IProviderAdapter
{
    public const string ProviderId = "test-rotating-store";
    public const string ReceiptsResource = "receipts";

    public const string Username = "rotating-user";
    public const string Password = "rotating-password";

    /// <summary>Declared on the resource and rejected from a query string.</summary>
    public const string InternalParam = "operator_cursor";

    private const string Currency = "EUR";

    private static readonly ProviderManifest Contract = Build();

    public ProviderManifest Describe() => Contract;

    public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        ctx.Progress(JobStep.Authenticating);
        ctx.CredentialSubmitted();

        return Task.FromResult(new LoginResult
        {
            Material = new SessionMaterial
            {
                AccessToken = $"rot-access-0-{ctx.SessionId}",
                RefreshToken = $"rot-refresh-0-{ctx.SessionId}",
            },
            Account = new ProviderAccount { DisplayName = "Rotating Test Store", ExternalId = Username },
        });
    }

    public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);

        if (!string.Equals(request.ResourceId, ReceiptsResource, StringComparison.Ordinal))
        {
            throw ConnectorException.Unsupported($"{ProviderId}: no resource '{request.ResourceId}'");
        }

        ctx.Progress(JobStep.Downloading);

        // Dated relative to now rather than pinned, so the window filter is
        // exercised without the suite acquiring an expiry date.
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var receipts = new[] { Receipt(ctx.SessionId, today.AddDays(-3), 1250), Receipt(ctx.SessionId, today.AddDays(-9), 480) }
            .Where(r => InWindow(r, request))
            .ToList();

        ctx.Progress(JobStep.Normalizing);

        // populated only when the caller asked: the staging layer must preserve that up to the response and no further
        var raw = new Dictionary<string, string>(StringComparer.Ordinal);
        if (request.WantsRaw)
        {
            foreach (var receipt in receipts)
            {
                raw[receipt.ExternalId] = $"{{\"provider_said\":\"{receipt.ExternalId}\"}}";
            }
        }

        return Task.FromResult(new FetchResult
        {
            Receipts = receipts,
            Raw = raw,
            // The provider rotated its refresh token upstream, so the bundle the
            // caller is holding is now stale and it must persist the new one.
            RefreshedMaterial = new SessionMaterial
            {
                AccessToken = $"rot-access-1-{ctx.SessionId}",
                RefreshToken = $"rot-refresh-1-{ctx.SessionId}",
            },
            Complete = true,
            Via = "test:rotating",
        });
    }

    private static bool InWindow(Receipt receipt, ResourceRequest request)
    {
        var day = DateOnly.FromDateTime(receipt.PurchasedAt.UtcDateTime);
        if (request.Since is { } since && day < since) return false;
        return request.Until is not { } until || day <= until;
    }

    private static Receipt Receipt(string sessionId, DateOnly day, long totalMinor)
    {
        var externalId = $"rot-{day:yyyy-MM-dd}";

        return new Receipt
        {
            // The control plane re-mints both of these when it stages the record.
            // the adapter still states them so the contract reads honestly.
            Id = Ids.ForRecord(Ids.Receipt, sessionId, externalId),
            ExternalId = externalId,
            Merchant = new Merchant { Id = ProviderId, Name = "Rotating Test Store" },
            PurchasedAt = new DateTimeOffset(day.ToDateTime(new TimeOnly(12, 0)), TimeSpan.Zero),
            Total = new Money(totalMinor, Currency),
            Payment = new ReceiptPayment { Method = "card", CardLast4 = "9911" },
            Items =
            [
                new ReceiptItem { Name = "Rotating basket", Quantity = 1, Total = new Money(totalMinor, Currency) },
            ],
        };
    }

    private static ProviderManifest Build() => new()
    {
        Id = ProviderId,
        Name = "Rotating Test Store",
        Kind = ProviderKind.Store,
        Country = "NL",
        ManifestVersion = 1,
        Runtime = ProviderRuntime.Http,
        Agent = AgentRequirement.Inline,
        UnattendedFetch = true,
        // the only offline provider with a declared logout: of the shipped fleet only Amazon logs out, and needs a real account
        Logout = LogoutSupport.Session,
        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        Auth = new AuthSpec
        {
            Flow = AuthFlow.Password,
            Steps =
            [
                new AuthStep
                {
                    Id = "credentials",
                    LabelKey = "connect.step.credentials",
                    Fields =
                    [
                        new FieldSpec { Key = "username", Type = FieldType.Text, LabelKey = "connect.field.username" },
                        new FieldSpec
                        {
                            Key = "password",
                            Type = FieldType.Password,
                            Secret = true,
                            LabelKey = "connect.field.password",
                        },
                    ],
                },
            ],
            Session = new SessionSpec { TtlSeconds = 2_592_000, Refreshable = true, RotatesOnUse = true },
            Reauth = new ReauthSpec { Cheap = true, TriggerCodes = ["session_expired"] },
        },
        Resources =
        [
            new ResourceSpec
            {
                Id = ReceiptsResource,
                Returns = ResourceShape.Receipt,
                Params =
                [
                    new ParamSpec { Key = "since", Type = ParamType.Date, Required = true },
                    new ParamSpec { Key = "until", Type = ParamType.Date },
                    new ParamSpec
                    {
                        Key = "include",
                        Type = ParamType.Enum,
                        Values = ["items", "raw"],
                        Multi = true,
                    },
                    new ParamSpec { Key = InternalParam, Type = ParamType.Text, Internal = true },
                ],
                TypicalDurationSeconds = 1,
            },
        ],
        Limits = new ProviderLimits { MinIntervalSeconds = 60 },
    };
}
