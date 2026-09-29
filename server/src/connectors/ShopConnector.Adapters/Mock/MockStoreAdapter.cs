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

/// <summary>
/// The offline backbone. One adapter, six registered identities, and not one
/// byte of network traffic between them.
///
/// These ship before any real provider and stay useful afterwards: they are
/// how the control plane, the agent protocol, the challenge relay and the
/// consuming app are all exercised end to end without an account, a browser
/// or an egress IP. Every output is deterministic given a session id, so a
/// test can assert on ids and content hashes rather than on shapes.
/// </summary>
public sealed class MockStoreAdapter : IProviderAdapter
{
    public const string ReceiptsResource = "receipts";

    /// <summary>
    /// A valid 1x1 PNG. Deliberately minimal - its job is to prove that real
    /// image bytes survive capture, redaction, upload and rendering, not to
    /// look like a CAPTCHA.
    /// </summary>
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

        // The one path that must exist offline: a credential the provider
        // rejects, so the never-retry rule can be tested without an account
        // to lock.
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

        // WHICH DOOR THIS SIGN-IN WENT THROUGH, for the same reason the fetch
        // note below exists: the mock fleet is what proves the note path end to
        // end, and a SIGN-IN is where a real adapter writes most of its notes.
        // ING alone says which of two login screens it was served, whether the
        // password form ever opened and what scope came back - and until a
        // session carried notes, every one of those went to the agent's stdout.
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
            // Deterministic and obviously fake: a mock token that looked
            // real would eventually be pasted somewhere real.
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
            // The alert path: provider_changed degrades the provider and
            // pages an operator, and is never retried.
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

        var all = MockReceiptFixture
            .Read(_profile.FixtureName, _profile.Id, ctx.SessionId, request.WantsItems)
            .ToList();

        var receipts = all.Where(r => ReceiptFactory.InWindow(r.PurchasedAt, request)).ToList();

        // Said out loud, because "you bought nothing then" and "your window
        // excluded everything" are the same empty list to whoever asked. Real
        // adapters carry the same kind of sentence for the same reason; this
        // one is here so the mock fleet exercises the note path end to end
        // rather than leaving it only ever proven by a unit test.
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

        // Derived from the session id rather than random, so a second run of
        // the same test routes to the same profile. A real T4 login takes
        // these from the agent that served the job.
        var agentId = Value(ctx, "agent_id") ?? Ids.ForRecord(Ids.Agent, ctx.SessionId, "mock-agent");
        var profileId = Value(ctx, "profile_id") ?? Ids.ForRecord(Ids.Profile, ctx.SessionId, "mock-profile");

        return new LoginResult
        {
            // No secret at all - the whole point of agent custody.
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

    /// <summary>
    /// Walks the progress vocabulary slowly, which is what a consumer needs
    /// to see an SSE stream do something and what an agent needs to have to
    /// renew a lease mid-job.
    /// </summary>
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
