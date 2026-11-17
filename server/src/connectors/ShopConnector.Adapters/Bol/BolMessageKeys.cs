namespace ShopConnector.Adapters.Bol;

// its own file: MessageKeys is shared by every provider and adding one must not touch it
internal static class BolMessageKeys
{
    public const string BolNotes = "connect.bol.notes";

    // not the sms key: bol's credential is an e-mail address, so the code likelier arrives in a mailbox.
    // the challenge's delivery field says which, per login
    public const string VerificationCode = "connect.challenge.verification_code";
}
