using System.Globalization;
using System.Text;
using Connector.Kit.Sessions;
using Microsoft.EntityFrameworkCore;
using Xunit.Sdk;

namespace Connector.Api.Tests.Infrastructure;

/// <summary>
/// Attaches the state of a run to whatever assertion killed it.
///
/// Written for a failure nobody has ever seen the message of.
/// <c>InteractiveLoginTests</c> and <c>RefreshLoopApiTests</c> each failed
/// during a full-solution run on 2026-08-12, on a machine that was building
/// containers at the time, and neither was reproducible afterwards - across
/// twenty-odd runs, six of the API suite alone, three of the whole solution,
/// and one under deliberate CPU load. A first fix was written against a race
/// found by reading the code; the test then failed again with that fix in
/// place, which is how it was established that the diagnosis was wrong.
///
/// The problem is not the flake. It is that a flake which happens once a week
/// during a run nobody is watching produces one line of xUnit output and
/// nothing else, so each occurrence teaches nothing and the next guess is as
/// blind as the last. This makes the occurrence itself the evidence.
///
/// Deliberately not a retry. A retry would make the suite green and the
/// question permanently unanswerable.
/// </summary>
internal static class Postmortem
{
    /// <summary>
    /// Runs a test body and, if anything throws, re-throws with the session's
    /// own rows appended - state, jobs, steps, error codes and challenges.
    /// </summary>
    /// <remarks>
    /// The session id is resolved lazily because the interesting failures
    /// happen after it is known but before the test has finished with it.
    /// Nothing here reads a bundle or a credential: the columns are the ones
    /// an operator would look at, and a bundle in an assertion message would
    /// be a sealed secret in a CI log.
    /// </remarks>
    public static async Task WatchAsync(
        ShopApiFactory factory, Func<string?> sessionId, Func<Task> body)
    {
        ArgumentNullException.ThrowIfNull(factory);
        ArgumentNullException.ThrowIfNull(sessionId);
        ArgumentNullException.ThrowIfNull(body);

        try
        {
            await body();
        }
        catch (Exception failure)
        {
            var report = Describe(factory, sessionId());

            // XunitException so the message reads as the assertion's own rather
            // than as a new kind of error, with the original kept as the inner
            // exception so its stack trace survives intact.
            throw new XunitException(
                $"{failure.Message}{Environment.NewLine}{Environment.NewLine}{report}",
                failure);
        }
    }

    private static string Describe(ShopApiFactory factory, string? sessionId)
    {
        var report = new StringBuilder();
        report.AppendLine("--- postmortem -------------------------------------------------");

        if (string.IsNullOrEmpty(sessionId))
        {
            report.AppendLine("no session id was known yet, so the failure is before or during /login");
            return report.ToString();
        }

        try
        {
            var session = Db.Read(factory, db => db.Sessions
                .Where(s => s.Id == sessionId)
                .Select(s => new { s.Id, s.State, s.ProviderId, s.CreatedAt, s.UpdatedAt, s.ExpiresAt })
                .FirstOrDefault());

            report.AppendLine(session is null
                ? $"session {sessionId}: NO ROW"
                : string.Create(CultureInfo.InvariantCulture,
                    $"session {session.Id}: state={session.State} provider={session.ProviderId} " +
                    $"created={session.CreatedAt:HH:mm:ss.fff} updated={session.UpdatedAt:HH:mm:ss.fff} " +
                    $"expires={session.ExpiresAt:HH:mm:ss.fff}"));

            var jobs = Db.Read(factory, db => db.Jobs
                .Where(j => j.SessionId == sessionId)
                .OrderBy(j => j.CreatedAt)
                .Select(j => new
                {
                    j.Id, j.Kind, j.State, j.ErrorCode, j.StepsDoneJson,
                    j.CreatedAt, j.UpdatedAt, j.LeaseOwner, j.Attempts,
                })
                .ToList());

            report.AppendLine(string.Create(CultureInfo.InvariantCulture, $"{jobs.Count} job(s):"));

            foreach (var job in jobs)
            {
                report.AppendLine(string.Create(CultureInfo.InvariantCulture,
                    $"  {job.Id} {job.Kind}/{job.State} lease={job.LeaseOwner ?? "-"} attempts={job.Attempts} " +
                    $"error={(job.ErrorCode is { } e ? e.ToString() : "-")} created={job.CreatedAt:HH:mm:ss.fff} " +
                    $"updated={job.UpdatedAt:HH:mm:ss.fff} steps={job.StepsDoneJson}"));
            }

            var challenges = Db.Read(factory, db => db.Challenges
                .Where(c => db.Jobs.Any(j => j.Id == c.JobId && j.SessionId == sessionId))
                .OrderBy(c => c.CreatedAt)
                .Select(c => new { c.Id, c.Type, c.CreatedAt, c.ExpiresAt, c.AnsweredAt })
                .ToList());

            report.AppendLine(string.Create(CultureInfo.InvariantCulture, $"{challenges.Count} challenge(s):"));

            foreach (var challenge in challenges)
            {
                report.AppendLine(string.Create(CultureInfo.InvariantCulture,
                    $"  {challenge.Id} {challenge.Type} " +
                    $"created={challenge.CreatedAt:HH:mm:ss.fff} expires={challenge.ExpiresAt:HH:mm:ss.fff} " +
                    $"answered={(challenge.AnsweredAt is { } a ? a.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture) : "-")}"));
            }
        }
        catch (Exception ex)
        {
            // A postmortem that throws would replace the real failure with its
            // own, which is the one thing it must never do.
            report.AppendLine($"(the postmortem itself failed: {ex.GetType().Name}: {ex.Message})");
        }

        report.AppendLine("----------------------------------------------------------------");
        return report.ToString();
    }
}
