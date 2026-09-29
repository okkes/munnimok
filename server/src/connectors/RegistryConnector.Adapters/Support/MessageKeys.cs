namespace RegistryConnector.Adapters.Support;

/// <summary>
/// Keys, never prose. A connector emits an identifier and the consuming app
/// owns the words - so a Dutch build, a screen-reader build and a plain-text
/// build all read differently from the same connector.
/// </summary>
internal static class MessageKeys
{
    public const string StepCredentials = "connect.step.credentials";

    public const string FieldEmail = "connect.field.email";
    public const string FieldPassword = "connect.field.password";

    /// <summary>
    /// The streamed sign-in. Shared wording with the shop connectors on
    /// purpose: it is the same thing happening, and a person who has met it
    /// once should recognise it.
    /// </summary>
    public const string LiveLogin = "connect.challenge.live_login";

    /// <summary>Six digits from the authenticator, asked for rather than computed.</summary>
    public const string BkrCode = "connect.challenge.authenticator_code";

    /// <summary>
    /// The seed field's label, and the one string here that has to carry a
    /// warning rather than a name. What it is asking for is the secret behind
    /// every code the account will ever accept.
    /// </summary>
    public const string BkrTotpSecret = "connect.bkr.totp";

    public const string BkrNotes = "connect.bkr.notes";

    /// <summary>
    /// DUO's streamed sign-in. Its own key rather than <see cref="LiveLogin"/>,
    /// because what the consumer has to say here is different: this is DigiD,
    /// the human needs their phone as well as their password, and there is no
    /// stored-credential shortcut that will ever remove the step.
    /// </summary>
    public const string DuoLiveLogin = "connect.challenge.digid_login";

    /// <summary>The QR to scan with the DigiD app.</summary>
    public const string DuoQr = "connect.challenge.digid_qr";

    /// <summary>The six digits DigiD just texted.</summary>
    public const string DuoSmsCode = "connect.challenge.digid_sms_code";

    /// <summary>
    /// DigiD's own username, which is not an e-mail address and not a BSN -
    /// worth its own key rather than reusing the e-mail one, because somebody
    /// typing their e-mail here will simply be refused by DigiD.
    /// </summary>
    public const string DuoUsername = "connect.duo.username";

    public const string DuoPassword = "connect.duo.password";

    /// <summary>Which DigiD method to drive, when credentials are stored.</summary>
    public const string DuoMethod = "connect.duo.method";

    /// <summary>
    /// What a person should know before connecting DUO: every sync needs a
    /// DigiD sign-in, and the balance carries no date.
    /// </summary>
    public const string DuoNotes = "connect.duo.notes";
}
