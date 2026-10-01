using RegistryConnector.Adapters.Duo;
using Xunit;

namespace RegistryConnector.Adapters.Tests;

/// <summary>
/// WHERE THE TOKEN DUO ISSUED IS KEPT, which is the root cause of two failed
/// live runs on 2026-09-20 and the one thing about them that no stub can
/// prove.
///
/// The carry lives inside a JavaScript string, because that is the whole
/// design: DUO's services authenticate on a header the portal mints, and the
/// only way to send it back without copying a credential into this process is
/// to read it and re-present it inside the tab that already holds the session.
/// Nothing but Chromium can RUN that string, so this suite holds it to the
/// properties a live run had to teach us instead - and says plainly that it is
/// a text test, rather than pretending to be more.
///
/// What it pins is not style. <c>window.__duoCarry</c> is destroyed by a
/// navigation, DUO's page navigates mid-sequence, and that is exactly how the
/// token went missing and every call after it came back 401.
/// </summary>
public sealed class DuoCarryTests
{
    private static readonly string Script = PageDuoPortal.FetchScript;

    /// <summary>
    /// <c>sessionStorage</c> is partitioned by ORIGIN and survives a
    /// same-origin navigation in the tab, which is precisely the event that
    /// destroyed the carry in both runs.
    /// </summary>
    [Fact]
    public void The_carried_token_is_kept_in_the_origins_session_store()
    {
        Assert.Contains("sessionStorage.getItem(carryKey)", Script, StringComparison.Ordinal);
        Assert.Contains("sessionStorage.setItem(carryKey, JSON.stringify(store))", Script, StringComparison.Ordinal);
    }

    /// <summary>
    /// And the page's own object is a FALLBACK, for the origins where the
    /// session store throws outright - blocked site data, an opaque document.
    /// It is read only after the store has been asked, so a page that has one
    /// never quietly prefers the copy a navigation deletes.
    /// </summary>
    [Fact]
    public void The_page_object_is_read_only_after_the_session_store_has_been_asked()
    {
        var store = Script.IndexOf("sessionStorage.getItem(carryKey)", StringComparison.Ordinal);
        var window = Script.IndexOf("window.__duoCarry ||", StringComparison.Ordinal);

        Assert.True(store >= 0, "the session store is not read at all");
        Assert.True(window > store, "the page object is read before the session store, so a navigation still wins");
    }

    /// <summary>
    /// THE STORES THAT WERE REFUSED, and why each one is worse rather than
    /// merely different.
    ///
    /// <c>window.name</c> survives a navigation too - including a CROSS-origin
    /// one, which is the whole problem: surviving into <c>login.digid.nl</c>
    /// means handing DUO's credential to DigiD. <c>localStorage</c> outlives
    /// the tab, turning a fifteen-minute token into a stored secret somebody
    /// has to look after. A cookie would be attached to requests by the
    /// browser itself, to any path that matched.
    /// </summary>
    [Fact]
    public void The_carry_is_never_parked_where_it_outlives_the_tab_or_leaves_the_origin()
    {
        Assert.DoesNotContain("window.name", Script, StringComparison.Ordinal);
        Assert.DoesNotContain("localStorage", Script, StringComparison.Ordinal);
        Assert.DoesNotContain("document.cookie", Script, StringComparison.Ordinal);
    }

    /// <summary>
    /// The key is unmistakably this connector's own. DUO's single-page app
    /// uses the same store, and writing under a name it happens to use would
    /// corrupt the portal this fetch is running inside.
    /// </summary>
    [Fact]
    public void The_key_is_this_connectors_own_and_not_one_DUOs_app_might_use()
    {
        Assert.Equal("__connector_duo_carry", PageDuoPortal.CarryKey);
        Assert.Contains("carryKey", Script, StringComparison.Ordinal);
    }

    /// <summary>
    /// The names the request CARRIED are read before the fetch, because after
    /// it there may be no page left to ask - which is exactly the case this
    /// instrument exists for.
    /// </summary>
    [Fact]
    public void What_a_request_carried_is_read_before_the_fetch_that_may_not_return()
    {
        var sent = Script.IndexOf("const sent = Object.keys(headers)", StringComparison.Ordinal);
        var fetched = Script.IndexOf("await fetch(", StringComparison.Ordinal);

        Assert.True(sent >= 0, "the request's own header names are never read");
        Assert.True(fetched > sent, "the header names are read after the fetch, which an interrupted call never reaches");

        // And they are lowercase, so a line reads the same whichever half of
        // the pair a name came from. The carried one arrives through
        // Headers.forEach, which lowercases; a literal spelled "Accept" would
        // log as "sent [Accept authorization]" and invite somebody to read the
        // casing as meaning something. The fixture portal is held to the same
        // spelling - see DuoFetchTests.
        Assert.Contains("{ 'accept': 'application/json' }", Script, StringComparison.Ordinal);
    }

    /// <summary>
    /// And a VALUE never leaves the page. Both lists that come back are
    /// <c>Object.keys</c> and <c>names.push(name)</c>: a name is a diagnostic,
    /// a value is a credential, and the only place a header value is ever
    /// written is back into the carry.
    /// </summary>
    [Fact]
    public void Only_header_names_are_ever_returned_to_this_process()
    {
        Assert.Contains("sent,", Script, StringComparison.Ordinal);
        Assert.Contains("const sent = Object.keys(headers);", Script, StringComparison.Ordinal);
        Assert.Contains("names.push(name);", Script, StringComparison.Ordinal);
        Assert.DoesNotContain("names.push(value)", Script, StringComparison.Ordinal);
        Assert.DoesNotContain("headers: headers", Script, StringComparison.Ordinal);
    }
}
