using System.Collections.Concurrent;
using Connector.Kit;
using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;

namespace Connector.Api.Tests.Infrastructure;

/// <summary>
/// A store whose budget refuses the first fetches of every session and
/// serves the ones after: the GoCardless shape of 2026-10-08, where ING's
/// handful of balance reads a day ran out mid-sync and the refusal, a fact
/// about the day, ended the session for good. No shipped mock refuses a
/// fetch with <c>rate_limited</c>, and the queue retries that code, so the
/// double refuses as many times as the queue will ask before it gives up.
/// </summary>
internal sealed class BudgetStoreAdapter : IProviderAdapter
{
    public const string ProviderId = "test-budget-store";
    public const string ReceiptsResource = "receipts";

    public const string Username = "budget-user";
    public const string Password = "budget-password";

    private const string Currency = "EUR";

    private static readonly ProviderManifest Contract = Build();

    private readonly ConcurrentDictionary<string, int> _fetches = new(StringComparer.Ordinal);

    public ProviderManifest Describe() => Contract;

    public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ctx.Progress(JobStep.Authenticating);
        ctx.CredentialSubmitted();
        return Task.FromResult(new LoginResult
        {
            Material = new SessionMaterial { AccessToken = $"budget-access-{ctx.SessionId}" },
            Account = new ProviderAccount { DisplayName = "Budget Test Store", ExternalId = Username },
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

        // every attempt of the first fetch is refused; the queue gives up after MaxAttempts
        var attempt = _fetches.AddOrUpdate(ctx.SessionId, 1, (_, n) => n + 1);
        if (attempt <= EfLeasedJobQueue.MaxAttempts)
        {
            throw new ConnectorException(ErrorCode.RateLimited, $"{ProviderId}: the day's budget is spent") { RetryAfterSeconds = 1800 };
        }

        ctx.Progress(JobStep.Downloading);
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var externalId = $"budget-{today:yyyy-MM-dd}";
        var receipt = new Receipt
        {
            Id = Ids.ForRecord(Ids.Receipt, ctx.SessionId, externalId),
            ExternalId = externalId,
            Merchant = new Merchant { Id = ProviderId, Name = "Budget Test Store" },
            PurchasedAt = new DateTimeOffset(today.AddDays(-1).ToDateTime(new TimeOnly(12, 0)), TimeSpan.Zero),
            Total = new Money(990, Currency),
            Payment = new ReceiptPayment { Method = "card", CardLast4 = "0042" },
            Items = [new ReceiptItem { Name = "Budget basket", Quantity = 1, Total = new Money(990, Currency) }],
        };
        ctx.Progress(JobStep.Normalizing);
        return Task.FromResult(new FetchResult { Receipts = [receipt], Complete = true, Via = "test:budget" });
    }

    private static ProviderManifest Build() => new()
    {
        Id = ProviderId,
        Name = "Budget Test Store",
        Kind = ProviderKind.Store,
        Country = "NL",
        ManifestVersion = 1,
        Runtime = ProviderRuntime.Http,
        Agent = AgentRequirement.Inline,
        UnattendedFetch = true,
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
                        new FieldSpec { Key = "password", Type = FieldType.Password, Secret = true, LabelKey = "connect.field.password" },
                    ],
                },
            ],
            Session = new SessionSpec { TtlSeconds = 2_592_000, Refreshable = true },
            Reauth = new ReauthSpec { Cheap = true, TriggerCodes = ["session_expired"] },
        },
        Resources =
        [
            new ResourceSpec
            {
                Id = ReceiptsResource,
                Returns = ResourceShape.Receipt,
                Params = [new ParamSpec { Key = "since", Type = ParamType.Date, Required = true }],
                TypicalDurationSeconds = 1,
            },
        ],
        Limits = new ProviderLimits { MinIntervalSeconds = 60 },
    };
}
