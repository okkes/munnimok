using Xunit;

namespace Connector.Kit.Tests;

// prefixes make a job id passed where a session id belongs obvious in review; ids are lookup keys, so unguessable
public sealed class IdsTests
{
    public static TheoryData<string> EveryPrefix()
    {
        var data = new TheoryData<string>();
        foreach (var prefix in All) data.Add(prefix);
        return data;
    }

    private static readonly string[] All =
    [
        Ids.Session, Ids.Job, Ids.Challenge, Ids.Agent, Ids.Profile, Ids.Ticket,
        Ids.Account, Ids.Transaction, Ids.Receipt, Ids.Cursor, Ids.Error, Ids.Event,
    ];

    [Fact]
    public void The_prefixes_are_the_published_ones()
    {
        // connector-api-spec.md publishes these; consumers pattern-match on them
        Assert.Equal("ses", Ids.Session);
        Assert.Equal("job", Ids.Job);
        Assert.Equal("chl", Ids.Challenge);
        Assert.Equal("agt", Ids.Agent);
        Assert.Equal("prf", Ids.Profile);
        Assert.Equal("tkt", Ids.Ticket);
        Assert.Equal("acc", Ids.Account);
        Assert.Equal("txn", Ids.Transaction);
        Assert.Equal("rcp", Ids.Receipt);
        Assert.Equal("cur", Ids.Cursor);
        Assert.Equal("err", Ids.Error);
        Assert.Equal("evt", Ids.Event);
    }

    [Fact]
    public void Every_prefix_is_distinct()
    {
        Assert.Equal(All.Length, All.Distinct(StringComparer.Ordinal).Count());
    }

    [Theory]
    [MemberData(nameof(EveryPrefix))]
    public void A_minted_id_is_its_prefix_plus_128_random_bits(string prefix)
    {
        var id = Ids.New(prefix);

        Assert.Matches($"^{prefix}_[0-9a-f]{{32}}$", id);
        Assert.True(Ids.Is(id, prefix));
    }

    [Fact]
    public void A_minted_id_is_never_the_same_twice()
    {
        var minted = Enumerable.Range(0, 512).Select(_ => Ids.New(Ids.Session)).ToList();

        Assert.Equal(minted.Count, minted.Distinct(StringComparer.Ordinal).Count());
    }

    [Theory]
    [InlineData("ses_abc", "ses", true)]
    [InlineData("job_abc", "ses", false)]
    [InlineData("session_abc", "ses", false)]
    [InlineData("ses", "ses", false)]
    [InlineData("SES_abc", "ses", false)]       // ordinal, never case-insensitive
    [InlineData("", "ses", false)]
    [InlineData(null, "ses", false)]
    public void Recognises_only_its_own_prefix(string? id, string prefix, bool expected)
    {
        Assert.Equal(expected, Ids.Is(id, prefix));
    }

    [Fact]
    public void A_record_id_is_deterministic_for_the_same_inputs()
    {
        // with content hashing, the same upstream data gives the same ids, so a re-run never duplicates
        var first = Ids.ForRecord(Ids.Transaction, Make.SessionId, "NL91-2026-07-19-0001");
        var second = Ids.ForRecord(Ids.Transaction, Make.SessionId, "NL91-2026-07-19-0001");

        Assert.Equal(first, second);
        Assert.Matches("^txn_[0-9a-f]{32}$", first);
        Assert.True(Ids.Is(first, Ids.Transaction));
    }

    [Fact]
    public void A_record_id_changes_with_every_component()
    {
        var baseline = Ids.ForRecord(Ids.Transaction, Make.SessionId, "e-1");

        Assert.NotEqual(baseline, Ids.ForRecord(Ids.Receipt, Make.SessionId, "e-1"));
        Assert.NotEqual(baseline, Ids.ForRecord(Ids.Transaction, Make.AccountId, "e-1"));
        Assert.NotEqual(baseline, Ids.ForRecord(Ids.Transaction, Make.SessionId, "e-2"));
    }

    [Fact]
    public void The_same_external_id_in_two_sessions_is_two_records()
    {
        // provider ids are unique per account, not globally: two users' receipts numbered from 1 must not collide
        var mine = Ids.ForRecord(Ids.Receipt, "ses_" + new string('a', 32), "1");
        var theirs = Ids.ForRecord(Ids.Receipt, "ses_" + new string('b', 32), "1");

        Assert.NotEqual(mine, theirs);
    }

    [Fact]
    public void A_record_id_is_not_a_minted_id()
    {
        // derived and random ids look alike on purpose, so a caller cannot tell and start deriving its own
        Assert.Matches("^rcp_[0-9a-f]{32}$", Ids.ForRecord(Ids.Receipt, Make.SessionId, "e-1"));
        Assert.Matches("^rcp_[0-9a-f]{32}$", Ids.New(Ids.Receipt));
    }
}
