namespace Connector.Kit.Agent.Browsing;

// per JOB, not per session: the connector refuses a frame whose sequence is not above its held one, answering 200 either way
// a counter restarting at 0 per session silently discards a job's second live view (AgentJobContext holds this one)
// gaps are fine, going backwards is not: a retried frame is a different picture and must take a new number
internal sealed class LiveFrameSequence
{
    private long _last;

    public long Last => Interlocked.Read(ref _last);

    public long Next() => Interlocked.Increment(ref _last);
}
