using RegistryConnector.Adapters.Duo;
using Xunit;

namespace RegistryConnector.Adapters.Tests;

// the carry is a JS string only Chromium can run, so this text test pins what live runs taught: window.__duoCarry dies
// on navigation, DUO's page navigates mid-sequence, and the token went missing (every later call 401)
public sealed class DuoCarryTests
{
    private static readonly string Script = PageDuoPortal.FetchScript;

    // sessionStorage is per origin and survives a same-origin navigation, the event that destroyed the carry
    [Fact]
    public void The_carried_token_is_kept_in_the_origins_session_store()
    {
        Assert.Contains("sessionStorage.getItem(carryKey)", Script, StringComparison.Ordinal);
        Assert.Contains("sessionStorage.setItem(carryKey, JSON.stringify(store))", Script, StringComparison.Ordinal);
    }

    // the page object is only a fallback (store throws: blocked site data, opaque document), read after the store
    [Fact]
    public void The_page_object_is_read_only_after_the_session_store_has_been_asked()
    {
        var store = Script.IndexOf("sessionStorage.getItem(carryKey)", StringComparison.Ordinal);
        var window = Script.IndexOf("window.__duoCarry ||", StringComparison.Ordinal);

        Assert.True(store >= 0, "the session store is not read at all");
        Assert.True(window > store, "the page object is read before the session store, so a navigation still wins");
    }

    // refused stores: window.name survives a cross-origin navigation (hands DUO's credential to DigiD), localStorage
    // outlives the tab, a cookie is attached by the browser to any matching path
    [Fact]
    public void The_carry_is_never_parked_where_it_outlives_the_tab_or_leaves_the_origin()
    {
        Assert.DoesNotContain("window.name", Script, StringComparison.Ordinal);
        Assert.DoesNotContain("localStorage", Script, StringComparison.Ordinal);
        Assert.DoesNotContain("document.cookie", Script, StringComparison.Ordinal);
    }

    // DUO's single-page app uses the same store: a name it might use would corrupt the portal
    [Fact]
    public void The_key_is_this_connectors_own_and_not_one_DUOs_app_might_use()
    {
        Assert.Equal("__connector_duo_carry", PageDuoPortal.CarryKey);
        Assert.Contains("carryKey", Script, StringComparison.Ordinal);
    }

    // header names are read before the fetch: after an interrupted call there may be no page left to ask
    [Fact]
    public void What_a_request_carried_is_read_before_the_fetch_that_may_not_return()
    {
        var sent = Script.IndexOf("const sent = Object.keys(headers)", StringComparison.Ordinal);
        var fetched = Script.IndexOf("await fetch(", StringComparison.Ordinal);

        Assert.True(sent >= 0, "the request's own header names are never read");
        Assert.True(fetched > sent, "the header names are read after the fetch, which an interrupted call never reaches");

        // lowercase, as Headers.forEach yields them, so log lines read the same for both halves (see DuoFetchTests)
        Assert.Contains("{ 'accept': 'application/json' }", Script, StringComparison.Ordinal);
    }

    // a name is a diagnostic, a value a credential: header values are only ever written back into the carry
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
