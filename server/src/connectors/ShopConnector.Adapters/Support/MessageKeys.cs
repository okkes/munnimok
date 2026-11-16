namespace ShopConnector.Adapters.Support;

/// every user-facing string is a key: a connector cannot know the reader's language, and a literal becomes an
/// untranslatable de-facto API once a consumer matches on it; the app owns the copy
internal static class MessageKeys
{
    public const string PasteRedirect = "connect.ah.paste_redirect";

    /// shown above a streamed login: must say whose page this is and that what is typed goes to them
    public const string LiveLogin = "connect.challenge.live_login";
    public const string SmsCode = "connect.challenge.sms_code";
    public const string Captcha = "connect.challenge.captcha";

    /// not SmsCode: a provider taking phone or e-mail sends the code either way, and "the code we texted you" misleads
    /// half the users; the challenge's delivery field says which it was
    public const string VerificationCode = "connect.challenge.verification_code";

    /// the wall nobody can relay: passed in the browser window the agent opened, nothing to type back
    public const string CaptchaInBrowser = "connect.challenge.captcha_in_browser";

    public const string FieldEmail = "connect.field.email";
    public const string FieldPassword = "connect.field.password";

    /// one box that takes either; replaces Lidl's phone-only key, whose label named only one accepted shape
    public const string FieldEmailOrPhone = "connect.field.email_or_phone";

    public const string LidlCountry = "connect.lidl.country";
    public const string LidlLanguage = "connect.lidl.language";

    public const string StepCredentials = "connect.step.credentials";
    public const string StepRedirect = "connect.step.redirect";

    /// provider-neutral: several providers hand sign-in to the human's browser, and a key naming one
    /// reads as the wrong brand in another's UI
    public const string SignInOnProviderSite = "connect.challenge.sign_in_on_site";

    public const string JumboNotes = "connect.jumbo.notes";
    public const string AhNotes = "connect.ah.notes";
    public const string LidlNotes = "connect.lidl.notes";
    public const string MockNotes = "connect.mock.notes";
}
