using System.Net.Mail;
using System.Text.RegularExpressions;
using FluentValidation;
using Munni.Api.Accounts;
using Munni.Api.Social;
using Munni.Api.Sync;

namespace Munni.Api.Validation;

/// <summary>
/// The relay's stable connection id (#367) is opaque to us, so only its
/// shape is policed — and by ONE rule, because bodies (validators) and
/// route segments (connection sync) both have to agree on it.
/// </summary>
public static partial class ConnectionIds
{
    public const int MaxLength = 64;
    public const string Pattern = "^[A-Za-z0-9._:-]+$";

    public static bool IsValid(string id) => id.Length is > 0 and <= MaxLength && Shape().IsMatch(id);

    [GeneratedRegex(Pattern)]
    private static partial Regex Shape();
}

public sealed class RegisterFeedRequestValidator : AbstractValidator<RegisterFeedRequest>
{
    public RegisterFeedRequestValidator()
    {
        RuleFor(r => r.FeedSpaceId).NotEmpty().MaximumLength(64)
            .Must(FeedAccess.IsFeedShaped).WithMessage("feed ids are deterministic uuidv5 values");
        RuleFor(r => r.AccountRef).NotEmpty().MaximumLength(64);
    }
}

public sealed class AttachAccountRequestValidator : AbstractValidator<AttachAccountRequest>
{
    public AttachAccountRequestValidator()
    {
        RuleFor(r => r.FeedSpaceId).NotEmpty().MaximumLength(64);
        RuleFor(r => r.AccountId).NotEmpty().MaximumLength(64);
        // every attachment carries its history gate — never silently unlimited
        RuleFor(r => r.HistoryFrom).NotEmpty().Matches(@"^\d{4}-\d{2}-\d{2}$").WithMessage("historyFrom must be yyyy-mm-dd");
        // the space's pick for the account; absent = the account row's own type
        RuleFor(r => r.Type).Must(t => AccountTypes.All.Contains(t!)).When(r => r.Type is not null)
            .WithMessage("type must be one of " + string.Join(", ", AccountTypes.All));
    }
}

public sealed class UpdateMeRequestValidator : AbstractValidator<UpdateMeRequest>
{
    public UpdateMeRequestValidator()
    {
        RuleFor(r => r.DisplayName).NotEmpty().MaximumLength(100);
        // preset avatar id ("icon|#color") or a small data URL — the client
        // downscales uploads to ≤256px JPEG, well under this cap
        RuleFor(r => r.Picture).MaximumLength(65_536);
        RuleFor(r => r.Country).Matches("^[A-Za-z]{2}$").When(r => !string.IsNullOrEmpty(r.Country));
        // '' is the explicit "clear back to as-recorded" sentinel
        RuleFor(r => r.DisplayCurrency).Matches("^[A-Za-z]{3}$").When(r => !string.IsNullOrEmpty(r.DisplayCurrency));
    }
}

public sealed class SendFriendRequestValidator : AbstractValidator<SendFriendRequest>
{
    public SendFriendRequestValidator()
    {
        RuleFor(r => r.ToUserId).NotEmpty();
        // #169: the optional space piggyback (ownership is checked in the handler)
        RuleFor(r => r.SpaceId).MaximumLength(64);
        RuleFor(r => r.Role).Must(role => SpaceRoles.Assignable.Contains(role!)).When(r => !string.IsNullOrEmpty(r.Role))
            .WithMessage("role must be owner, contributor or reader");
        RuleFor(r => r.SpaceName).MaximumLength(200);
    }
}

public sealed class SendSpaceInviteValidator : AbstractValidator<SendSpaceInvite>
{
    public SendSpaceInviteValidator()
    {
        RuleFor(r => r.ToUserId).NotEmpty();
        RuleFor(r => r.Role).NotEmpty().Must(SpaceRoles.Assignable.Contains).WithMessage("role must be owner, contributor or reader");
        RuleFor(r => r.SpaceName).MaximumLength(200);
    }
}

public sealed class ChangeRoleRequestValidator : AbstractValidator<ChangeRoleRequest>
{
    public ChangeRoleRequestValidator()
    {
        RuleFor(r => r.Role).NotEmpty().Must(SpaceRoles.Assignable.Contains).WithMessage("role must be owner, contributor or reader");
        // #172: the client sends the space's name along for the push text
        RuleFor(r => r.SpaceName).MaximumLength(200);
    }
}

public sealed class SyncOpDtoValidator : AbstractValidator<SyncOpDto>
{
    private static readonly string[] Entities = ["space", "account", "category", "transaction", "txMeta", "accountLink", "recurring", "recurringDismiss", "budget", "event", "goal", "goalContribution", "debt", "receipt", "receiptLink", "storeMarker", "storeConn", "storeConnLink", "holding", "lot", "insightDismiss", "plan", "planSubject", "activity", "txSeen"];

    public SyncOpDtoValidator()
    {
        RuleFor(o => o.OpId).NotEmpty().MaximumLength(64);
        RuleFor(o => o.SpaceId).NotEmpty().MaximumLength(64);
        RuleFor(o => o.Entity).NotEmpty().Must(Entities.Contains).WithMessage("unknown entity");
        // 128, not 64: composite ids are legitimate — a plan is
        // `plan:{space-uuid}:{kind}:{period}` (~60 for real spaces) and a
        // mirrored plan subject adds `psub:…:{segment}:{uuid}` on top. A too-tight
        // limit 400s the push and POISONS the outbox: everything queued
        // after the op (a hundred store receipts, say) never syncs again
        RuleFor(o => o.EntityId).NotEmpty().MaximumLength(128);
        RuleFor(o => o.Hlc).NotEmpty().MaximumLength(64);
        RuleFor(o => o.Fields).NotNull();
    }
}

public sealed class PushRequestValidator : AbstractValidator<PushRequest>
{
    public PushRequestValidator()
    {
        RuleFor(r => r.ClientId).NotEmpty().MaximumLength(64);
        RuleFor(r => r.Ops).NotNull();
        RuleFor(r => r.Ops.Count).LessThanOrEqualTo(1000).WithMessage("push at most 1000 ops per request");
        RuleForEach(r => r.Ops).SetValidator(new SyncOpDtoValidator());
    }
}

public sealed class RenameDeviceRequestValidator : AbstractValidator<Munni.Api.Auth.RenameDeviceRequest>
{
    public RenameDeviceRequestValidator()
    {
        RuleFor(r => r.Name).NotEmpty().MaximumLength(60);
    }
}

public sealed class SubscribeRequestValidator : AbstractValidator<Munni.Api.Push.SubscribeRequest>
{
    public SubscribeRequestValidator()
    {
        RuleFor(r => r.Kind).Must(k => k is "webpush" or "fcm").WithMessage("kind must be webpush or fcm");
        RuleFor(r => r.Lang).Must(l => l is null or "en" or "nl" or "tr").WithMessage("lang must be en, nl or tr");
        RuleFor(r => r.Endpoint).NotEmpty().MaximumLength(4096);
        // browser subscriptions: a real push-service URL plus its key pair
        When(r => r.Kind == "webpush", () =>
        {
            RuleFor(r => r.Endpoint)
                .MaximumLength(2048)
                .Must(url => Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps)
                .WithMessage("endpoint must be an absolute https URL");
            RuleFor(r => r.P256dh).NotEmpty().MaximumLength(256);
            RuleFor(r => r.Auth).NotEmpty().MaximumLength(128);
        });
    }
}

/// <summary>
/// The relay's request bodies (#367). Bundles are sealed material a browser
/// profile can make large, so their cap is generous; everything else is a
/// name, a key or a typed value. Input VALUES are never inspected beyond
/// their length: what a user typed into a provider's form is the provider's
/// business, sealed before it rests anywhere.
/// </summary>
public sealed class ConnectorLoginRequestValidator : AbstractValidator<Connectors.ConnectorLoginRequest>
{
    public ConnectorLoginRequestValidator()
    {
        RuleFor(r => r.ConnectionId).NotEmpty().MaximumLength(ConnectionIds.MaxLength).Matches(ConnectionIds.Pattern);
        RuleFor(r => r.Label).MaximumLength(80);
        RuleFor(r => r.CredentialBundle).MaximumLength(Connectors.ConnectorLoginRequest.BundleMaximumLength);
        RuleFor(r => r.PreferAgent).MaximumLength(64);
        RuleFor(r => r.IdempotencyKey).MaximumLength(128);
        RuleFor(r => r.Inputs).Must(SmallMap).When(r => r.Inputs is not null).WithMessage("inputs: at most 32 keys of 64 chars, values of 4096");
        RuleFor(r => r.Config).Must(SmallMap).When(r => r.Config is not null).WithMessage("config: at most 32 keys of 64 chars, values of 4096");
    }

    private static bool SmallMap(Dictionary<string, string>? map) =>
        map is null || (map.Count <= 32 && map.All(p => p.Key.Length is > 0 and <= 64 && p.Value.Length <= 4096));
}

public sealed class ConnectorAnswerRequestValidator : AbstractValidator<Connectors.ConnectorAnswerRequest>
{
    public ConnectorAnswerRequestValidator()
    {
        RuleFor(r => r.ChallengeId).NotEmpty().MaximumLength(64);
        RuleFor(r => r.Value).MaximumLength(4096);
    }
}

public sealed class ConnectorSyncRequestValidator : AbstractValidator<Connectors.ConnectorSyncRequest>
{
    public ConnectorSyncRequestValidator()
    {
        RuleFor(r => r.ConnectionId).NotEmpty().MaximumLength(ConnectionIds.MaxLength).Matches(ConnectionIds.Pattern);
        RuleFor(r => r.Bundle).NotEmpty().MaximumLength(Connectors.ConnectorLoginRequest.BundleMaximumLength);
        RuleFor(r => r.Since).Matches(@"^\d{4}-\d{2}-\d{2}$").When(r => r.Since is not null).WithMessage("since must be yyyy-mm-dd");
    }
}

public sealed class ConnectorCollectRequestValidator : AbstractValidator<Connectors.ConnectorCollectRequest>
{
    public ConnectorCollectRequestValidator()
    {
        RuleFor(r => r.Bundle).NotEmpty().MaximumLength(Connectors.ConnectorLoginRequest.BundleMaximumLength);
    }
}

public sealed class ConnectorDisconnectRequestValidator : AbstractValidator<Connectors.ConnectorDisconnectRequest>
{
    public ConnectorDisconnectRequestValidator()
    {
        RuleFor(r => r.Bundle).MaximumLength(Connectors.ConnectorLoginRequest.BundleMaximumLength);
    }
}

public sealed class ConnectorProviderStatusRequestValidator : AbstractValidator<Connectors.ConnectorProviderStatusRequest>
{
    public ConnectorProviderStatusRequestValidator()
    {
        RuleFor(r => r.State).Must(Connectors.ConnectorLabEndpoints.IsState).WithMessage("state must be healthy, degraded, paused or retired");
        RuleFor(r => r.ReasonKey).MaximumLength(120);
    }
}

public sealed class ConnectorEnrollmentRequestValidator : AbstractValidator<Connectors.ConnectorEnrollmentRequest>
{
    public ConnectorEnrollmentRequestValidator()
    {
        RuleFor(r => r.Name).NotEmpty().MaximumLength(80);
    }
}

public sealed class RegisterDeviceRequestValidator : AbstractValidator<Connectors.RegisterDeviceRequest>
{
    public RegisterDeviceRequestValidator()
    {
        RuleFor(r => r.DeviceId).NotEmpty().MaximumLength(64);
        RuleFor(r => r.PublicJwk).NotEmpty().MaximumLength(2048);
        RuleFor(r => r.Name).NotEmpty().MaximumLength(80);
    }
}

public sealed class WrapRequestValidator : AbstractValidator<Connectors.WrapRequest>
{
    public WrapRequestValidator()
    {
        RuleFor(r => r.WrappedCsk).NotEmpty().MaximumLength(4096);
    }
}

public sealed class ConnectionCipherRequestValidator : AbstractValidator<Connectors.ConnectionCipherRequest>
{
    public ConnectionCipherRequestValidator()
    {
        RuleFor(r => r.Cipher).NotEmpty().MaximumLength(16384);
    }
}

/// <summary>
/// user 2026-10-07: invitation-only sign-up — the operator types an address
/// into the admin portal: one real address, no display-name form, no
/// whitespace inside, 254 characters at most (RFC 5321's path limit). The
/// handler trims and lower-cases it; Logto keys the magic link on the exact string.
/// </summary>
public sealed class CreateInvitationRequestValidator : AbstractValidator<Admin.CreateInvitationRequest>
{
    public CreateInvitationRequestValidator()
    {
        RuleFor(r => r.Email).NotEmpty().MaximumLength(254)
            .Must(BeOneAddress).WithMessage("email must be a single valid address");
    }

    /// <summary>MailAddress parses display-name forms too ("Ann &lt;ann@x.y&gt;"): the parsed address has to be the whole trimmed input</summary>
    private static bool BeOneAddress(string? email)
    {
        var address = email?.Trim();
        return address is { Length: > 0 }
               && !address.Any(char.IsWhiteSpace)
               && MailAddress.TryCreate(address, out var parsed)
               && string.Equals(parsed.Address, address, StringComparison.OrdinalIgnoreCase);
    }
}
