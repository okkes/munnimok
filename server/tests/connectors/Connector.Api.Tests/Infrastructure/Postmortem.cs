using System.Globalization;
using System.Text;
using Connector.Kit.Sessions;
using Microsoft.EntityFrameworkCore;
using Xunit.Sdk;

namespace Connector.Api.Tests.Infrastructure;

// attaches the run's state to the assertion that killed it: a rare flake in an unwatched run leaves one line of xUnit output
// deliberately not a retry: a retry would make the suite green and the question unanswerable
internal static class Postmortem
{
    // the session id is resolved lazily; no bundle or credential is read: a bundle in a message would be a secret in a CI log
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

            // XunitException so the message reads as the assertion's own; the original stays inner so its stack trace survives
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
