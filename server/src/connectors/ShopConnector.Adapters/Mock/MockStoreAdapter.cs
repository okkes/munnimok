using Connector.Kit;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Mock;

/// The offline backbone: six identities, no network. Output is deterministic given session id and clock,
/// so tests assert on ids and content hashes rather than shapes.
public sealed class MockStoreAdapter : IProviderAdapter
{
    public const string ReceiptsResource = "receipts";

    /// a valid 1x1 PNG: proves real image bytes survive capture, redaction, upload and rendering
    private const string PlaceholderPngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    private static readonly IReadOnlyList<JobStep> SlowSteps =
    [
        JobStep.OpeningProvider, JobStep.Authenticating, JobStep.SelectingAccounts,
        JobStep.Downloading, JobStep.Parsing, JobStep.Normalizing, JobStep.Finalizing,
    ];

    private readonly MockStoreProfile _profile;
    private readonly ProviderManifest _manifest;
    private readonly TimeProvider _time;

    public MockStoreAdapter(MockStoreProfile profile, TimeProvider? time = null)
    {
        ArgumentNullException.ThrowIfNull(profile);

        _profile = profile;
        _manifest = MockStoreManifest.Build(profile);
        _time = time ?? TimeProvider.System;
    }

    public ProviderManifest Describe() => _manifest;

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        if (_profile.Behaviour == MockStoreBehaviour.Persistent) return PersistentLogin(ctx);

        ctx.Progress(JobStep.Authenticating);

        var username = Required(ctx, "username");
        var password = Required(ctx, "password");

        // the offline path for a rejected credential, so the never-retry rule is testable without an account to lock
        if (string.Equals(password, _profile.RejectedPassword, StringComparison.Ordinal))
        {
            ctx.CredentialSubmitted();
            throw ConnectorException.InvalidCredentials($"{_profile.Id}: the fixture rejects this password");
        }

        ctx.CredentialSubmitted();

        switch (_profile.Behaviour)
        {
            case MockStoreBehaviour.SmsChallenge:
                await AnswerSmsAsync(ctx, ct).ConfigureAwait(false);
                break;

            case MockStoreBehaviour.ImageChallenge:
                await AnswerImageAsync(ctx, ct).ConfigureAwait(false);
                break;

            case MockStoreBehaviour.Slow:
                await WalkSlowlyAsync(ctx, ct).ConfigureAwait(false);
                break;

            default:
                break;
        }

        // the mock fleet proves the sign-in note path end to end; a real adapter writes most of its notes at sign-in
        if (_profile.Behaviour is MockStoreBehaviour.SmsChallenge or MockStoreBehaviour.ImageChallenge)
        {
            ctx.Note(
                $"{_profile.Id}: this sign-in was interrupted by a "
                + $"{(_profile.Behaviour == MockStoreBehaviour.SmsChallenge ? "code" : "picture")} challenge, "
                + "which the caller answered");
        }

        ctx.Progress(JobStep.Finalizing);

        return new LoginResult
        {
            // obviously fake: a realistic mock token would eventually be pasted somewhere real
            Material = new SessionMaterial
            {
                AccessToken = $"mock-access-{ctx.SessionId}",
                RefreshToken = $"mock-refresh-{ctx.SessionId}",
                AccessTokenExpiresAt = _time.GetUtcNow().AddHours(1),
            },
            Account = new ProviderAccount { DisplayName = _profile.Name, ExternalId = username },
        };
    }

    public async Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);

        if (!string.Equals(request.ResourceId, ReceiptsResource, StringComparison.Ordinal))
        {
            throw ConnectorException.Unsupported($"{_profile.Id}: no resource '{request.ResourceId}'");
        }

        if (_profile.Behaviour == MockStoreBehaviour.Broken)
        {
            // the alert path: provider_changed degrades the provider, pages an operator and is never retried
            throw ConnectorException.ProviderChanged(
                $"{_profile.Id}: this provider always reports a shape change, by design");
        }

        if (_profile.Behaviour == MockStoreBehaviour.Slow)
        {
            await WalkSlowlyAsync(ctx, ct).ConfigureAwait(false);
        }
        else
        {
            ctx.Progress(JobStep.Downloading);
            ctx.Progress(JobStep.Parsing);
        }

        // the fixture's receipts up to now, as far back as the manifest's history limit (the limit the platform clamps since to)
        var all = MockReceiptFixture
            .Read(
                _profile.FixtureName,
                _profile.Id,
                ctx.SessionId,
                request.WantsItems,
                _time.GetUtcNow(),
                _manifest.Resource(ReceiptsResource)?.MaxHistoryDays ?? _manifest.Limits.MaxHistoryDays)
            .ToList();

        var receipts = all.Where(r => ReceiptFactory.InWindow(r.PurchasedAt, request)).ToList();

        // said out loud: "bought nothing" and "window excluded everything" are the same empty list; also exercises the note path
        if (all.Count > receipts.Count)
        {
            ctx.Note(
                $"{_profile.Id}: {all.Count - receipts.Count} of {all.Count} receipt(s) fell outside the " +
                "requested window and were left out");
        }

        ctx.Progress(JobStep.Normalizing);

        return new FetchResult
        {
            Receipts = receipts,
            Complete = true,
            Via = $"fixture:{_profile.FixtureName}",
        };
    }

    private LoginResult PersistentLogin(IJobContext ctx)
    {
        ctx.Progress(JobStep.Finalizing);

        // derived from the session id so a rerun routes to the same profile; a real T4 login takes these from the serving agent
        var agentId = Value(ctx, "agent_id") ?? Ids.ForRecord(Ids.Agent, ctx.SessionId, "mock-agent");
        var profileId = Value(ctx, "profile_id") ?? Ids.ForRecord(Ids.Profile, ctx.SessionId, "mock-profile");

        return new LoginResult
        {
            // no secret at all: agent custody
            Material = SessionMaterial.ForAgent(agentId, profileId),
            Account = new ProviderAccount { DisplayName = _profile.Name, ExternalId = profileId },
        };
    }

    private async Task AnswerSmsAsync(IJobContext ctx, CancellationToken ct)
    {
        ctx.Progress(JobStep.AwaitingHuman);

        var answer = await ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.MfaCode,
            PromptKey = MessageKeys.SmsCode,
            Delivery = "sms",
            Length = _profile.SmsCode.Length,
            ExpiresAt = _time.GetUtcNow().AddMinutes(5),
        }, ct).ConfigureAwait(false);

        if (!string.Equals(answer.Value.Trim(), _profile.SmsCode, StringComparison.Ordinal))
        {
            throw new ConnectorException(ErrorCode.MfaFailed, $"{_profile.Id}: wrong code");
        }
    }

    private async Task AnswerImageAsync(IJobContext ctx, CancellationToken ct)
    {
        ctx.Progress(JobStep.AwaitingHuman);

        var answer = await ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.Image,
            PromptKey = MessageKeys.Captcha,
            Image = Convert.FromBase64String(PlaceholderPngBase64),
            Crop = new CropRegion(0, 0, 1, 1),
            ExpiresAt = _time.GetUtcNow().AddMinutes(5),
        }, ct).ConfigureAwait(false);

        if (!string.Equals(answer.Value.Trim(), _profile.CaptchaAnswer, StringComparison.OrdinalIgnoreCase))
        {
            throw new ConnectorException(ErrorCode.MfaFailed, $"{_profile.Id}: wrong captcha answer");
        }
    }

    /// slow on purpose: lets a consumer see an SSE stream move and an agent renew a lease mid-job
    private async Task WalkSlowlyAsync(IJobContext ctx, CancellationToken ct)
    {
        foreach (var step in SlowSteps)
        {
            ct.ThrowIfCancellationRequested();
            ctx.Progress(step);

            if (_profile.StepDelay > TimeSpan.Zero)
            {
                await Task.Delay(_profile.StepDelay, _time, ct).ConfigureAwait(false);
            }
        }
    }

    private string Required(IJobContext ctx, string key) =>
        ctx.Inputs.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw ConnectorException.InvalidRequest($"{_profile.Id}: '{key}' is required");

    private static string? Value(IJobContext ctx, string key) =>
        ctx.Config.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value) ? value : null;
}
