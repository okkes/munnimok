using Connector.Kit.Challenges;
using Connector.Kit.Manifests;

namespace RegistryConnector.Adapters.Mock;

internal static class MockRegistryManifest
{
    /// <summary>An hour, short on purpose: a month-long cache would promise a sync that needs a human.</summary>
    public const int SessionTtlSeconds = 3_600;

    public static ProviderManifest Build(string id, string name, bool twoFactor) => new()
    {
        Id = id,
        Name = name,
        Kind = ProviderKind.Registry,
        Fixture = true,
        Country = "NL",
        ManifestVersion = 1,
        Runtime = ProviderRuntime.Http,
        Agent = AgentRequirement.Inline,

        // false when a code is needed per sync: stops a consumer offering scheduled sync to somebody who must be awake for each
        UnattendedFetch = !twoFactor,
        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "mock",
        NotesKey = "connect.mock.notes",

        // the 2FA variant stores username and password (they never change) and asks for the six digits (they do)
        OffersCredentialStore = twoFactor,

        Auth = new AuthSpec
        {
            Flow = twoFactor ? AuthFlow.PasswordTotp : AuthFlow.Password,
            Steps =
            [
                new AuthStep
                {
                    Id = "credentials",
                    LabelKey = "connect.step.credentials",
                    Fields =
                    [
                        new FieldSpec
                        {
                            Key = "username",
                            Type = FieldType.Text,
                            Required = true,
                            LabelKey = "connect.field.username",
                        },
                        new FieldSpec
                        {
                            Key = "password",
                            Type = FieldType.Password,
                            Secret = true,
                            Required = true,
                            LabelKey = "connect.field.password",
                        },
                    ],
                },
            ],
            Challenges = twoFactor ? [ChallengeType.MfaCode] : [],
            Session = new SessionSpec
            {
                TtlSeconds = SessionTtlSeconds,

                // validator: unattended_fetch and refreshable must agree; with an authenticator there is nothing to refresh,
                // the next sync signs in again
                Refreshable = !twoFactor,

                // never re-issued either way; stated because the field defaults to true
                RotatesOnUse = false,
            },
            Reauth = new ReauthSpec { Cheap = !twoFactor, TriggerCodes = ["session_expired"] },
        },
        Resources =
        [
            new ResourceSpec
            {
                Id = MockRegistryAdapter.CreditsResource,
                Returns = ResourceShape.CreditRegistration,

                // no since: a registry states what is true now, so a window question has no answer
                Params = [],
            },
        ],
        Limits = new ProviderLimits { MinIntervalSeconds = 3_600, Concurrency = 1 },
    };
}
