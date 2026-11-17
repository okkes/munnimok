namespace RegistryConnector.Adapters.Support;

/// <summary>Keys, never prose: the consuming app owns the words.</summary>
internal static class MessageKeys
{
    public const string StepCredentials = "connect.step.credentials";

    public const string FieldEmail = "connect.field.email";
    public const string FieldPassword = "connect.field.password";

    // shared wording with the shop connectors on purpose: the same thing happens and should be recognised
    public const string LiveLogin = "connect.challenge.live_login";

    public const string BkrCode = "connect.challenge.authenticator_code";

    // the label must carry a warning: it asks for the secret behind every code the account will accept
    public const string BkrTotpSecret = "connect.bkr.totp";

    public const string BkrNotes = "connect.bkr.notes";

    // own key, not LiveLogin: this is DigiD, the human needs their phone too, and no stored credential removes the step
    public const string DuoLiveLogin = "connect.challenge.digid_login";

    public const string DuoQr = "connect.challenge.digid_qr";

    public const string DuoSmsCode = "connect.challenge.digid_sms_code";

    // DigiD's username is neither an e-mail nor a BSN; own key because an e-mail typed here is refused by DigiD
    public const string DuoUsername = "connect.duo.username";

    public const string DuoPassword = "connect.duo.password";

    public const string DuoMethod = "connect.duo.method";

    /// <summary>Every sync needs a DigiD sign-in, and the balance carries no date.</summary>
    public const string DuoNotes = "connect.duo.notes";
}
