using Connector.Kit.Challenges;
using Connector.Kit.Manifests;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Mock;

internal static class MockStoreManifest
{
    public const int Version = 1;

    public static ProviderManifest Build(MockStoreProfile profile) => profile.Behaviour == MockStoreBehaviour.Persistent
        ? Persistent(profile)
        : Inline(profile);

    /// all but the persistent mock are T1 inline (no browser, agent or network), so CI can run them offline
    private static ProviderManifest Inline(MockStoreProfile profile) => new()
    {
        Id = profile.Id,
        Name = profile.Name,
        Kind = ProviderKind.Store,
        Fixture = true,
        Country = "NL",
        ManifestVersion = Version,
        Runtime = ProviderRuntime.Http,
        Agent = AgentRequirement.Inline,
        UnattendedFetch = true,
        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "mock",
        NotesKey = MessageKeys.MockNotes,
        Auth = new AuthSpec
        {
            Flow = profile.Behaviour == MockStoreBehaviour.SmsChallenge ? AuthFlow.PasswordSms : AuthFlow.Password,
            Steps =
            [
                new AuthStep
                {
                    Id = "credentials",
                    LabelKey = MessageKeys.StepCredentials,
                    Fields =
                    [
                        new FieldSpec
                        {
                            Key = "username",
                            Type = FieldType.Text,
                            Secret = false,
                            LabelKey = MessageKeys.FieldEmail,
                            Autofill = "username",
                        },
                        new FieldSpec
                        {
                            Key = "password",
                            Type = FieldType.Password,
                            Secret = true,
                            LabelKey = MessageKeys.FieldPassword,
                            Autofill = "current-password",
                        },
                    ],
                },
            ],
            Challenges = profile.Behaviour switch
            {
                MockStoreBehaviour.SmsChallenge => [ChallengeType.MfaCode],
                MockStoreBehaviour.ImageChallenge => [ChallengeType.Image],
                _ => [],
            },
            Session = new SessionSpec { TtlSeconds = 2_592_000, Refreshable = true, RotatesOnUse = true },
            Reauth = new ReauthSpec { Cheap = true, TriggerCodes = ["session_expired"] },
        },
        Resources = [Receipts(profile)],
        // no rate limit worth enforcing in-process; a six-hour floor would make the mock useless for scheduler tests
        Limits = new ProviderLimits { MinIntervalSeconds = 60, Concurrency = 1 },
    };

    /// the BYO routing case: the bundle carries {agent_id, profile_id} and no credential, so the control plane holds no secret
    private static ProviderManifest Persistent(MockStoreProfile profile) => new()
    {
        Id = profile.Id,
        Name = profile.Name,
        Kind = ProviderKind.Store,
        Fixture = true,
        Country = "NL",
        ManifestVersion = Version,
        Runtime = ProviderRuntime.BrowserPersistent,
        Agent = new AgentRequirement { Required = true, Class = AgentClass.Byo },
        UnattendedFetch = true,
        SecretCustody = SecretCustody.Agent,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "mock",
        NotesKey = MessageKeys.MockNotes,
        Auth = new AuthSpec
        {
            // no credential step: the human authenticated once, into a profile on their own hardware
            Flow = AuthFlow.DevicePersistent,
            Steps = [],
            Session = new SessionSpec { TtlSeconds = 31_536_000, Refreshable = true, RotatesOnUse = false },
            Reauth = new ReauthSpec { Cheap = true, TriggerCodes = ["session_expired"] },
        },
        Resources = [Receipts(profile)],
        Limits = new ProviderLimits { MinIntervalSeconds = 60, Concurrency = 1 },
    };

    private static ResourceSpec Receipts(MockStoreProfile profile) => new()
    {
        Id = MockStoreAdapter.ReceiptsResource,
        Returns = ResourceShape.Receipt,
        Params =
        [
            new ParamSpec { Key = "since", Type = ParamType.Date, Required = true },
            new ParamSpec { Key = "until", Type = ParamType.Date },
            new ParamSpec { Key = "include", Type = ParamType.Enum, Values = ["items"], Multi = true },
        ],
        TypicalDurationSeconds = profile.Behaviour == MockStoreBehaviour.Slow ? 120 : 1,
        MaxRecordsPerFetch = 200,
    };
}
